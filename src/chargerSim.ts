// Simulated EV charger, speaking OCPP 2.0.1 or 1.6J.
//
// Boots, plugs in an EV, starts a transaction, then reports power and energy
// every `meterIntervalMs`. Obeys SetChargingProfile / ClearChargingProfile.
//
// Options model chargers as they exist in Australia, not just the ideal one:
// - `protocol: '1.6'`: most installed chargers still speak OCPP 1.6J.
// - `acceptsW: false`: amps-only, rejects profiles in watts.
// - `phases: 3`: amps limits are per phase, so 1 A = 3 x 230 W; reports power per phase.
// - `evMinAmpsPerPhase`: a real car stops charging below ~6 A per phase.
// - `reboot()`: drops the connection, forgets every profile, boots again.
// - `reconnect()`: drops the connection only (Wi-Fi blip): profiles kept, no boot.
// - `autoReconnect: true`: if the bridge goes away (restart, crash), keep
//   retrying with backoff and carry on charging when it's back, like a real
//   charger. Off by default so demos control every drop themselves.
import { RPCClient } from 'ocpp-rpc';

export type OcppVersion = '1.6' | '2.0.1';

export interface SimChargerOptions {
    id: string;
    endpoint: string; // e.g. ws://localhost:9000
    protocol?: OcppVersion; // default 2.0.1
    phases?: 1 | 3; // default 1
    voltage?: number; // per phase, default 230
    acceptsW?: boolean; // false = amps-only charger (default true)
    evMaxW?: number; // what the car would draw with no cap
    evMinAmpsPerPhase?: number; // below this the car stops (default 0 = never stops)
    meterIntervalMs?: number;
    password?: string; // OCPP Security Profile 1: sent with HTTP Basic auth (username = id)
    autoReconnect?: boolean; // default false: see the header comment
    log?: (msg: string) => void;
}

// The parts of a profile the sim needs, the same for both versions.
interface ReceivedProfile {
    id: number;
    unit: 'W' | 'A';
    limit: number;
    numberPhases?: number;
}

export class SimCharger {
    readonly id: string;
    readonly protocol: OcppVersion;
    readonly phases: 1 | 3;
    private voltage: number;
    private acceptsW: boolean;
    private evMaxW: number;
    private evMinAmpsPerPhase: number;
    private meterIntervalMs: number;
    private endpoint: string;
    private password?: string;
    private autoReconnect: boolean;
    private log: (msg: string) => void;

    private client!: RPCClient;
    // Active charging profiles, keyed by profile id, already converted to watts.
    // Kept in memory only: reboot() forgets them, like many real chargers do.
    private limitsW = new Map<number, number>();
    private energyWh = 0;
    private seqNo = 0;
    private transactionId = `tx-${Date.now()}`; // 2.0.1: chosen by the charger
    private transactionId16?: number; // 1.6: chosen by the CSMS in StartTransaction
    private meterTimer?: NodeJS.Timeout;
    private closing = false; // our own disconnect(), not a lost link

    constructor(opts: SimChargerOptions) {
        this.id = opts.id;
        this.endpoint = opts.endpoint;
        this.protocol = opts.protocol ?? '2.0.1';
        this.phases = opts.phases ?? 1;
        this.voltage = opts.voltage ?? 230;
        this.acceptsW = opts.acceptsW ?? true;
        this.evMaxW = opts.evMaxW ?? 7400;
        this.evMinAmpsPerPhase = opts.evMinAmpsPerPhase ?? 0;
        this.meterIntervalMs = opts.meterIntervalMs ?? 1000;
        this.password = opts.password;
        this.autoReconnect = opts.autoReconnect ?? false;
        this.log = opts.log ?? ((m) => console.log(`[${this.id}] ${m}`));
    }

    // Lowest limit wins; with no limits the car draws its max. If the limit
    // leaves less than the car's minimum current, the car stops (0 W).
    currentPowerW(): number {
        const allowedW = Math.min(this.evMaxW, ...this.limitsW.values());
        const minW = this.evMinAmpsPerPhase * this.voltage * this.phases;
        return allowedW < minW ? 0 : allowedW;
    }

    async start(): Promise<void> {
        await this.connect();
        await this.boot();
    }

    /** Power cycle: connection drops, profiles are forgotten, then boot and charge again. */
    async reboot(offlineMs = 500): Promise<void> {
        this.log('REBOOT: dropping connection and forgetting all charging profiles');
        await this.disconnect();
        this.limitsW.clear();
        await new Promise((r) => setTimeout(r, offlineMs));
        await this.start();
    }

    /** Network blip: connection drops and comes back. Profiles and the transaction survive, no boot. */
    async reconnect(offlineMs = 500): Promise<void> {
        this.log('RECONNECT: dropping connection (profiles kept)');
        await this.disconnect();
        await new Promise((r) => setTimeout(r, offlineMs));
        await this.connect();
        this.startMeterTimer();
    }

    async stop(): Promise<void> {
        await this.disconnect();
    }

    private async disconnect(): Promise<void> {
        clearInterval(this.meterTimer);
        this.closing = true;
        try {
            await this.client.close({ awaitPending: true });
        } finally {
            this.closing = false;
        }
    }

    private startMeterTimer(): void {
        clearInterval(this.meterTimer); // never two timers
        this.meterTimer = setInterval(() => {
            this.sendMeterValues().catch((err) => this.log(`meter values not sent: ${(err as Error).message}`));
        }, this.meterIntervalMs);
    }

    private setMeterIntervalS(seconds: number): void {
        this.meterIntervalMs = seconds * 1000;
        this.log(`now reporting power every ${seconds} s`);
        if (this.meterTimer) this.startMeterTimer();
    }

    // A fresh client per connection, so reconnect()/reboot() start clean.
    private async connect(): Promise<void> {
        // The library's option type marks every field required; we only need these.
        this.client = new RPCClient({
            endpoint: this.endpoint,
            identity: this.id, // becomes the URL path: ws://host:9000/<id>
            protocols: [this.protocol === '1.6' ? 'ocpp1.6' : 'ocpp2.0.1'],
            strictMode: true, // validate every message against the OCPP JSON schemas
            // Off: reconnect()/reboot() decide when to come back. On: ocpp-rpc
            // retries after an unexpected drop with exponential backoff (1 s,
            // 2 s, 4 s ... up to 10 s, +/-25% jitter). Our own close() never
            // triggers it.
            reconnect: this.autoReconnect,
            // ocpp-rpc sends "Authorization: Basic base64(<id>:<password>)" on connect.
            // A refused connect rejects with err.code = the HTTP status (401, 404).
            ...(this.password !== undefined && { password: this.password }),
        } as ConstructorParameters<typeof RPCClient>[0]);

        this.client.handle('SetChargingProfile', async ({ params }) => ({
            status: this.applyProfile(this.readProfile(params)),
        }));

        this.client.handle('ClearChargingProfile', async ({ params }) => {
            // 1.6 calls the profile id `id`, 2.0.1 `chargingProfileId`.
            const id = (this.protocol === '1.6' ? params!.id : params!.chargingProfileId) as number | undefined;
            // No id means "clear all" (ignoring the criteria filter for this sim).
            const existed = id === undefined ? this.limitsW.size > 0 : this.limitsW.has(id);
            if (id === undefined) this.limitsW.clear();
            else this.limitsW.delete(id);
            this.log(`ClearChargingProfile id=${id ?? 'all'} -> now drawing ${this.currentPowerW()} W`);
            return { status: existed ? 'Accepted' : 'Unknown' };
        });

        // How often to report, and that power is wanted. This sim always sends
        // power; a real charger may need telling.
        this.client.handle('ChangeConfiguration', async ({ params }) => {
            if (params!.key === 'MeterValueSampleInterval') this.setMeterIntervalS(Number(params!.value));
            return { status: 'Accepted' };
        });
        this.client.handle('SetVariables', async ({ params }) => ({
            setVariableResult: params!.setVariableData.map((d: { component: object; variable: { name: string }; attributeValue: string }) => {
                if (d.variable.name === 'TxUpdatedInterval') this.setMeterIntervalS(Number(d.attributeValue));
                return { attributeStatus: 'Accepted', component: d.component, variable: d.variable };
            }),
        }));

        if (this.autoReconnect) this.watchConnection(this.client);
        await this.client.connect();
    }

    // Auto-reconnect: meter values pause while the link is down (calls would
    // only fail), and resume when it's back. Profiles and the transaction are
    // kept and there's no new BootNotification: the charger didn't restart,
    // the bridge did. The bridge re-sends its cap after `bootWaitMs` anyway.
    private watchConnection(client: RPCClient): void {
        let opened = false;
        client.on('disconnect', ({ code }: { code: number }) => {
            if (this.closing || client !== this.client) return; // we closed it ourselves
            clearInterval(this.meterTimer);
            this.log(`connection lost (code ${code}), reconnecting with backoff (profiles kept)`);
        });
        client.on('open', () => {
            if (opened && client === this.client) {
                this.log(`reconnected -> drawing ${this.currentPowerW()} W`);
                this.startMeterTimer();
            }
            opened = true;
        });
    }

    // Same message name in both versions, different shapes:
    // 1.6:   { connectorId, csChargingProfiles: { chargingProfileId, chargingSchedule: {...} } }
    // 2.0.1: { evseId, chargingProfile: { id, chargingSchedule: [{...}] } }
    private readProfile(params: any): ReceivedProfile {
        if (this.protocol === '1.6') {
            const p = params.csChargingProfiles;
            const period = p.chargingSchedule.chargingSchedulePeriod[0];
            return { id: p.chargingProfileId, unit: p.chargingSchedule.chargingRateUnit, limit: period.limit, numberPhases: period.numberPhases };
        }
        const p = params.chargingProfile;
        const schedule = p.chargingSchedule[0];
        const period = schedule.chargingSchedulePeriod[0];
        return { id: p.id, unit: schedule.chargingRateUnit, limit: period.limit, numberPhases: period.numberPhases };
    }

    private applyProfile(p: ReceivedProfile): 'Accepted' | 'Rejected' {
        if (p.unit === 'W' && !this.acceptsW) {
            this.log(`SetChargingProfile id=${p.id} ${p.limit} W -> Rejected (amps-only charger)`);
            return 'Rejected';
        }
        // An amps limit is per phase. numberPhases defaults to 3 in both versions;
        // a single-phase charger can't use more phases than it has.
        const phasesUsed = Math.min(this.phases, p.numberPhases ?? 3);
        const watts = p.unit === 'A' ? p.limit * this.voltage * phasesUsed : p.limit;
        this.limitsW.set(p.id, watts);
        this.log(`SetChargingProfile id=${p.id} ${p.limit} ${p.unit} -> now drawing ${this.currentPowerW()} W`);
        return 'Accepted';
    }

    private async boot(): Promise<void> {
        const now = () => new Date().toISOString();
        if (this.protocol === '1.6') {
            const boot = (await this.client.call('BootNotification', {
                chargePointVendor: 'csip-ocpp-bridge',
                chargePointModel: 'SimCharger16',
            })) as { status: string };
            this.log(`BootNotification (1.6) -> ${boot.status}`);
            await this.client.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });
            const tx = (await this.client.call('StartTransaction', {
                connectorId: 1,
                idTag: 'SIMTAG',
                meterStart: Math.round(this.energyWh),
                timestamp: now(),
            })) as { transactionId: number };
            this.transactionId16 = tx.transactionId;
            this.log(`Transaction ${tx.transactionId} started`);
        } else {
            const boot = (await this.client.call('BootNotification', {
                reason: 'PowerUp',
                chargingStation: { model: 'SimCharger', vendorName: 'csip-ocpp-bridge' },
            })) as { status: string };
            this.log(`BootNotification -> ${boot.status}`);
            await this.client.call('StatusNotification', {
                timestamp: now(),
                connectorStatus: 'Occupied',
                evseId: 1,
                connectorId: 1,
            });
            this.transactionId = `tx-${Date.now()}`;
            await this.client.call('TransactionEvent', {
                eventType: 'Started',
                timestamp: now(),
                triggerReason: 'CablePluggedIn',
                seqNo: this.seqNo++,
                transactionInfo: { transactionId: this.transactionId, chargingState: 'Charging' },
                evse: { id: 1, connectorId: 1 },
            });
            this.log(`Transaction ${this.transactionId} started`);
        }
        this.startMeterTimer();
    }

    // Power samples: one total for a single-phase charger; one per phase
    // (L1, L2, L3, no total) for three-phase, as many real chargers report it.
    private powerSamples(powerW: number): { watts: number; phase?: 'L1' | 'L2' | 'L3' }[] {
        if (this.phases === 1) return [{ watts: powerW }];
        const perPhase = Math.floor(powerW / 3); // rounded down: the sum never overstates
        return (['L1', 'L2', 'L3'] as const).map((phase) => ({ watts: perPhase, phase }));
    }

    private async sendMeterValues(): Promise<void> {
        const powerW = this.currentPowerW();
        this.energyWh += (powerW * this.meterIntervalMs) / 3_600_000;
        const timestamp = new Date().toISOString();
        const energyWh = Math.round(this.energyWh * 10) / 10;

        if (this.protocol === '1.6') {
            // 1.6 uses the standalone MeterValues message, and values are strings.
            await this.client.call('MeterValues', {
                connectorId: 1,
                transactionId: this.transactionId16,
                meterValue: [
                    {
                        timestamp,
                        sampledValue: [
                            ...this.powerSamples(powerW).map((s) => ({
                                value: String(s.watts),
                                measurand: 'Power.Active.Import',
                                context: 'Sample.Periodic',
                                unit: 'W',
                                ...(s.phase && { phase: s.phase }),
                            })),
                            {
                                value: String(energyWh),
                                measurand: 'Energy.Active.Import.Register',
                                context: 'Sample.Periodic',
                                unit: 'Wh',
                            },
                        ],
                    },
                ],
            });
            return;
        }

        // During a transaction OCPP 2.0.1 reports meter values inside TransactionEvent
        // (eventType Updated), not the standalone MeterValues message.
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
                        ...this.powerSamples(powerW).map((s) => ({
                            value: s.watts,
                            measurand: 'Power.Active.Import',
                            context: 'Sample.Periodic',
                            unitOfMeasure: { unit: 'W' },
                            ...(s.phase && { phase: s.phase }),
                        })),
                        {
                            value: energyWh,
                            measurand: 'Energy.Active.Import.Register',
                            context: 'Sample.Periodic',
                            unitOfMeasure: { unit: 'Wh' },
                        },
                    ],
                },
            ],
        });
    }
}
