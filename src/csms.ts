// Minimal charger management server (CSMS).
//
// Accepts chargers on ws://localhost:<port>/<id> using subprotocol ocpp2.0.1,
// records their power readings, and can cap or uncap them.
import { RPCClient, RPCServer } from 'ocpp-rpc';

// The server's per-charger connection has the same call/handle API as a client.
type ServerClient = RPCClient;

// One id is enough while we only ever set a single station-wide cap.
const CAP_PROFILE_ID = 1;

export interface PowerReading {
    at: number; // ms since epoch, when the server received it
    watts: number;
}

/** Anything that reports power over time: a charger or the site meter. */
export interface Metered {
    readonly id: string;
    readonly readings: PowerReading[]; // oldest first
}

// The longest anything looks back is one telemetry interval (postRate, 300 s
// on real servers) plus a little. Keep three times that, so a gateway that
// runs for months doesn't fill its memory with readings.
const READING_RETENTION_MS = 15 * 60_000;

/** Add a reading and drop the ones older than READING_RETENTION_MS. */
export function addReading(readings: PowerReading[], reading: PowerReading): void {
    readings.push(reading);
    const cutoff = reading.at - READING_RETENTION_MS;
    let old = 0;
    while (old < readings.length && readings[old].at < cutoff) old++;
    if (old > 0) readings.splice(0, old);
}

export class ManagedCharger implements Metered {
    readonly readings: PowerReading[] = [];

    constructor(
        readonly id: string,
        private client: ServerClient,
        private log: (msg: string) => void,
    ) {}

    get latestW(): number | undefined {
        return this.readings.at(-1)?.watts;
    }

    // Cap the whole station (EVSE 0) with a ChargingStationMaxProfile.
    async capPower(watts: number): Promise<string> {
        const res = (await this.client.call('SetChargingProfile', {
            evseId: 0,
            chargingProfile: {
                id: CAP_PROFILE_ID,
                stackLevel: 0,
                chargingProfilePurpose: 'ChargingStationMaxProfile',
                chargingProfileKind: 'Absolute',
                chargingSchedule: [
                    {
                        id: 1,
                        chargingRateUnit: 'W',
                        startSchedule: new Date().toISOString(),
                        chargingSchedulePeriod: [{ startPeriod: 0, limit: watts }],
                    },
                ],
            },
        })) as { status: string };
        this.log(`SetChargingProfile ${watts} W -> ${res.status}`);
        return res.status;
    }

    async removeCap(): Promise<string> {
        const res = (await this.client.call('ClearChargingProfile', {
            chargingProfileId: CAP_PROFILE_ID,
        })) as { status: string };
        this.log(`ClearChargingProfile -> ${res.status}`);
        return res.status;
    }
}

export class Manager {
    readonly chargers = new Map<string, ManagedCharger>();
    private server: RPCServer;
    private waiters = new Map<string, (c: ManagedCharger) => void>();

    constructor(private log: (msg: string) => void = (m) => console.log(`[CSMS] ${m}`)) {
        this.server = new RPCServer({ protocols: ['ocpp2.0.1'], strictMode: true });

        this.server.on('client', (client: ServerClient) => {
            const id = client.identity!;
            const charger = new ManagedCharger(id, client, this.log);
            this.chargers.set(id, charger);
            this.log(`${id} connected`);

            client.handle('BootNotification', async () => ({
                currentTime: new Date().toISOString(),
                interval: 300,
                status: 'Accepted',
            }));

            client.handle('StatusNotification', async () => ({}));
            client.handle('Heartbeat', async () => ({ currentTime: new Date().toISOString() }));

            client.handle('TransactionEvent', async ({ params }) => {
                for (const mv of params!.meterValue ?? []) {
                    for (const sv of mv.sampledValue) {
                        if (sv.measurand === 'Power.Active.Import') {
                            addReading(charger.readings, { at: Date.now(), watts: sv.value });
                        }
                    }
                }
                return {};
            });

            client.on('close', () => {
                this.log(`${id} disconnected`);
                this.chargers.delete(id);
            });

            this.waiters.get(id)?.(charger);
            this.waiters.delete(id);
        });
    }

    async listen(port = 9000): Promise<void> {
        await this.server.listen(port);
        this.log(`listening on ws://localhost:${port}`);
    }

    waitForCharger(id: string): Promise<ManagedCharger> {
        const existing = this.chargers.get(id);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve) => this.waiters.set(id, resolve));
    }

    async close(): Promise<void> {
        await this.server.close({ awaitPending: true });
    }
}
