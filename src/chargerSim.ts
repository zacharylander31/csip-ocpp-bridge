// Simulated OCPP 2.0.1 EV charger.
//
// Boots, plugs in an EV, starts a transaction, then reports power and energy
// every `meterIntervalMs`. Obeys SetChargingProfile / ClearChargingProfile.
import { RPCClient } from 'ocpp-rpc';

const VOLTS = 230; // single phase assumption for amps -> watts
const PHASES = 1;

export interface SimChargerOptions {
    id: string;
    endpoint: string; // e.g. ws://localhost:9000
    evMaxW?: number; // what the car would draw with no cap
    meterIntervalMs?: number;
    log?: (msg: string) => void;
}

export class SimCharger {
    readonly id: string;
    private client: RPCClient;
    private evMaxW: number;
    private meterIntervalMs: number;
    private log: (msg: string) => void;

    // Active charging profiles, keyed by profile id, already converted to watts.
    private limitsW = new Map<number, number>();
    private energyWh = 0;
    private seqNo = 0;
    private transactionId = `tx-${Date.now()}`;
    private meterTimer?: NodeJS.Timeout;

    constructor(opts: SimChargerOptions) {
        this.id = opts.id;
        this.evMaxW = opts.evMaxW ?? 7400;
        this.meterIntervalMs = opts.meterIntervalMs ?? 1000;
        this.log = opts.log ?? ((m) => console.log(`[${this.id}] ${m}`));

        // The library's option type marks every field required; we only need these.
        this.client = new RPCClient({
            endpoint: opts.endpoint,
            identity: opts.id, // becomes the URL path: ws://host:9000/<id>
            protocols: ['ocpp2.0.1'],
            strictMode: true, // validate every message against the OCPP JSON schemas
        } as ConstructorParameters<typeof RPCClient>[0]);

        this.client.handle('SetChargingProfile', async ({ params }) => {
            const profile = params!.chargingProfile;
            const schedule = profile.chargingSchedule[0];
            const limit = schedule.chargingSchedulePeriod[0].limit as number;
            const watts =
                schedule.chargingRateUnit === 'A' ? limit * VOLTS * PHASES : limit;
            this.limitsW.set(profile.id, watts);
            this.log(
                `SetChargingProfile id=${profile.id} ${limit}${schedule.chargingRateUnit} -> now drawing ${this.currentPowerW()} W`,
            );
            return { status: 'Accepted' };
        });

        this.client.handle('ClearChargingProfile', async ({ params }) => {
            const id = params!.chargingProfileId as number | undefined;
            // No id means "clear all" (ignoring the criteria filter for this sim).
            const existed = id === undefined ? this.limitsW.size > 0 : this.limitsW.has(id);
            if (id === undefined) this.limitsW.clear();
            else this.limitsW.delete(id);
            this.log(`ClearChargingProfile id=${id ?? 'all'} -> now drawing ${this.currentPowerW()} W`);
            return { status: existed ? 'Accepted' : 'Unknown' };
        });
    }

    // Lowest limit wins; with no limits the car draws its max.
    currentPowerW(): number {
        return Math.min(this.evMaxW, ...this.limitsW.values());
    }

    async start(): Promise<void> {
        await this.client.connect();

        const boot = (await this.client.call('BootNotification', {
            reason: 'PowerUp',
            chargingStation: { model: 'SimCharger', vendorName: 'csip-ocpp-bridge' },
        })) as { status: string };
        this.log(`BootNotification -> ${boot.status}`);

        await this.client.call('StatusNotification', {
            timestamp: new Date().toISOString(),
            connectorStatus: 'Occupied',
            evseId: 1,
            connectorId: 1,
        });

        await this.client.call('TransactionEvent', {
            eventType: 'Started',
            timestamp: new Date().toISOString(),
            triggerReason: 'CablePluggedIn',
            seqNo: this.seqNo++,
            transactionInfo: { transactionId: this.transactionId, chargingState: 'Charging' },
            evse: { id: 1, connectorId: 1 },
        });
        this.log(`Transaction ${this.transactionId} started`);

        this.meterTimer = setInterval(() => void this.sendMeterValues(), this.meterIntervalMs);
    }

    // During a transaction OCPP 2.0.1 reports meter values inside TransactionEvent
    // (eventType Updated), not the standalone MeterValues message.
    private async sendMeterValues(): Promise<void> {
        const powerW = this.currentPowerW();
        this.energyWh += (powerW * this.meterIntervalMs) / 3_600_000;
        const timestamp = new Date().toISOString();
        await this.client.call('TransactionEvent', {
            eventType: 'Updated',
            timestamp,
            triggerReason: 'MeterValuePeriodic',
            seqNo: this.seqNo++,
            transactionInfo: { transactionId: this.transactionId },
            meterValue: [
                {
                    timestamp,
                    sampledValue: [
                        {
                            value: powerW,
                            measurand: 'Power.Active.Import',
                            context: 'Sample.Periodic',
                            unitOfMeasure: { unit: 'W' },
                        },
                        {
                            value: Math.round(this.energyWh * 10) / 10,
                            measurand: 'Energy.Active.Import.Register',
                            context: 'Sample.Periodic',
                            unitOfMeasure: { unit: 'Wh' },
                        },
                    ],
                },
            ],
        });
    }

    async stop(): Promise<void> {
        clearInterval(this.meterTimer);
        await this.client.close({ awaitPending: true });
    }
}
