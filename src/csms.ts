// Minimal charger management server (CSMS).
//
// Accepts chargers on ws://localhost:<port>/<id> speaking OCPP 2.0.1 or 1.6J,
// records their power readings, and can cap or uncap them. Bridge only sees
// ManagedCharger, which looks the same whichever version the charger speaks.
//
// Real-charger handling:
// - Units: a charger takes its cap in W or A (configured per charger). Amps
//   are per phase, converted with the configured phases and voltage, and
//   rounded DOWN to the charger's step, so a cap is never exceeded.
// - Minimum current: a car stops charging below ~6 A per phase. A cap below
//   that is sent as 0 (pause) instead, and reported in `lastCap`, so the
//   power can go to another charger later.
// - Reconnect: the ManagedCharger outlives its connection. When a charger
//   comes back (rebooted or not), the current cap is sent again, and the
//   charger only counts as `compliant` once it has accepted it.
import { RPCClient, RPCServer } from 'ocpp-rpc';

// The server's per-charger connection has the same call/handle API as a client.
type ServerClient = RPCClient;

export type OcppVersion = '1.6' | '2.0.1';

// One id is enough while we only ever set a single station-wide cap.
const CAP_PROFILE_ID = 1;

// After a charger connects, how long to wait for a BootNotification before
// re-sending the cap anyway. A rebooted charger boots first thing, and a
// CSMS shouldn't send it commands before that. A charger that only lost its
// network doesn't boot again, so after this wait we assume that's what happened.
const BOOT_WAIT_MS = 2000;

export interface ChargerConfig {
    rateUnit: 'W' | 'A'; // what the charger accepts in a charging profile
    phases: 1 | 3; // phases wired to the charger
    voltage: number; // nominal, per phase: decides whether a W share is above the minimum current
    maxVoltage: number; // highest the supply can reach, per phase: used to turn W into A
    ampStep: number; // amps are rounded down to a multiple of this
    minAmpsPerPhase: number; // below this the car stops: send 0 instead (0 = no minimum)
}

export const DEFAULT_CHARGER_CONFIG: ChargerConfig = {
    rateUnit: 'W',
    phases: 1,
    voltage: 230,
    // A car draws amps x the REAL voltage, and Australian supply often sits at
    // 240-250 V. Converting a W share to amps at 230 V would let it draw up to
    // ~10% more than its share. 253 V is the top of AS 60038 (230 V +10%), so
    // an amps cap worked out at 253 V stays within the share at any legal voltage.
    maxVoltage: 253,
    // Whole amps: plenty of chargers only take whole amps, and OCPP 1.6's
    // `multipleOf: 0.1` check fails on values like 6.3 in JavaScript
    // (6.3 / 0.1 = 62.99999999999999), so ocpp-rpc's strict mode refuses to send them.
    ampStep: 1,
    minAmpsPerPhase: 6, // IEC 61851: an AC car can't charge below 6 A
};

/** What a requested cap turns into on one charger. */
export interface CapPlan {
    requestedW: number; // what Bridge asked for
    unit: 'W' | 'A';
    limit: number; // the number sent in the profile, in `unit` (per phase if A)
    allowedW: number; // what the charger may actually draw: <= requestedW
    paused: boolean; // the share was below the minimum, so 0 was sent
}

/**
 * Turn a cap in watts into the limit to send. Pure, so it's easy to test.
 * Always rounds down: a charger must never be allowed more than its share.
 */
export function planCap(watts: number, cfg: ChargerConfig): CapPlan {
    const pause: CapPlan = { requestedW: watts, unit: cfg.rateUnit, limit: 0, allowedW: 0, paused: true };
    if (watts <= 0) return pause;
    if (cfg.rateUnit === 'W') {
        // The charger limits watts itself, so the voltage only matters for the minimum.
        if (watts / (cfg.voltage * cfg.phases) < cfg.minAmpsPerPhase) return pause;
        const limit = Math.floor(watts);
        return { requestedW: watts, unit: 'W', limit, allowedW: limit, paused: false };
    }
    // Amps at the highest possible voltage, so the real draw never exceeds the share.
    // The small epsilon stops 13.0 / 0.1 = 129.99999 rounding down a whole step;
    // the final round tidies 0.30000000000000004 to 0.3.
    const perPhaseA = watts / (cfg.maxVoltage * cfg.phases);
    const steps = Math.floor(perPhaseA / cfg.ampStep + 1e-9);
    const amps = Math.round(steps * cfg.ampStep * 1000) / 1000;
    if (amps === 0 || amps < cfg.minAmpsPerPhase) return pause;
    const allowedW = amps * cfg.maxVoltage * cfg.phases; // worst case
    return { requestedW: watts, unit: 'A', limit: amps, allowedW, paused: false };
}

/**
 * How long after a charger accepts a change before its readings can be
 * trusted to show it. Not zero: a reading the charger sent just before it
 * replied can be handled by ocpp-rpc a moment after the reply resolves (seen:
 * same millisecond, old power), and a real charger's meter may lag too.
 * Use readings from `ackedAt + SETTLE_MS` onwards.
 */
export const SETTLE_MS = 300;

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

// A power sample in either version, after reading the version-specific fields.
interface PowerSample {
    measurand?: string;
    phase?: string;
    watts: number;
}

/**
 * Total active import power from one meterValue's samples, or undefined if
 * it has none. Uses the total if the charger sent one; otherwise adds up the
 * per-phase values (L1, L2, L3 or L1-N...), as many three-phase chargers
 * only report per phase. A missing measurand means Energy.Active.Import.Register.
 */
export function totalPowerW(samples: PowerSample[]): number | undefined {
    const power = samples.filter((s) => s.measurand === 'Power.Active.Import');
    const total = power.find((s) => s.phase === undefined);
    if (total) return total.watts;
    const perPhase = power.filter((s) => /^L[123](-N)?$/.test(s.phase!));
    if (perPhase.length === 0) return undefined;
    return perPhase.reduce((sum, s) => sum + s.watts, 0);
}

// What Bridge last asked for; replayed after a reconnect.
type Wanted = { kind: 'cap'; watts: number } | { kind: 'none' };

export class ManagedCharger implements Metered {
    readonly readings: PowerReading[] = [];
    /** What the last accepted (or last sent) cap turned into: check `paused` and `allowedW`. */
    lastCap?: CapPlan;
    /** When the charger last accepted what Bridge wants, on its current connection. */
    compliantSince?: number;

    private client?: ServerClient;
    private _version?: OcppVersion;
    private connectionNo = 0;
    private wanted?: Wanted; // undefined: Bridge hasn't asked for anything yet
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        readonly id: string,
        readonly config: ChargerConfig,
        private log: (msg: string) => void,
    ) {}

    get latestW(): number | undefined {
        return this.readings.at(-1)?.watts;
    }

    get version(): OcppVersion | undefined {
        return this._version;
    }

    get connected(): boolean {
        return this.client !== undefined;
    }

    /** Whether it has ever connected (false for a charger created by Manager.expect that hasn't yet). */
    get hasConnected(): boolean {
        return this.connectionNo > 0;
    }

    /**
     * True when the charger is connected and has accepted Bridge's latest
     * request on this connection. False right after a reconnect, until the
     * cap has been sent again and accepted.
     */
    get compliant(): boolean {
        return this.connected && (this.wanted === undefined || this.compliantSince !== undefined);
    }

    /**
     * Cap the whole charger at `watts` (converted to amps if the charger needs
     * them; 0 if below the minimum current). Returns the charger's status.
     * Throws if the charger is offline; the cap is still remembered and sent
     * when it reconnects.
     */
    capPower(watts: number): Promise<string> {
        this.wanted = { kind: 'cap', watts };
        this.compliantSince = undefined;
        return this.send(this.wanted);
    }

    removeCap(): Promise<string> {
        this.wanted = { kind: 'none' };
        this.compliantSince = undefined;
        return this.send(this.wanted);
    }

    // ---- used by Manager ----

    attach(client: ServerClient, version: OcppVersion): void {
        this.client = client;
        this._version = version;
        this.connectionNo++;
        this.compliantSince = undefined; // whatever it had may be gone
    }

    detach(client: ServerClient): void {
        if (this.client !== client) return; // an old connection closing after the new one opened
        this.client = undefined;
        this.compliantSince = undefined;
    }

    /** Send the current cap again, e.g. after a reboot that lost it. */
    resync(why: string): void {
        if (!this.wanted || !this.connected) return;
        this.compliantSince = undefined;
        this.log(`${this.id} ${why}: re-sending ${this.wanted.kind === 'cap' ? `cap ${this.wanted.watts} W` : 'no cap'}`);
        this.send(this.wanted).catch((err) => this.log(`${this.id} re-send failed: ${(err as Error).message}`));
    }

    // ---- sending ----

    // One send at a time, in order, so a re-send and a new cap from Bridge
    // can't overtake each other: whatever Bridge asked for last lands last.
    private send(wanted: Wanted): Promise<string> {
        const run = this.queue.then(() => this.sendNow(wanted));
        this.queue = run.catch(() => {});
        return run;
    }

    private async sendNow(wanted: Wanted): Promise<string> {
        const client = this.client;
        if (!client) throw new Error(`${this.id} is offline`);
        const connectionNo = this.connectionNo;

        let status: string;
        if (wanted.kind === 'cap') {
            const plan = planCap(wanted.watts, this.config);
            status = await this.sendCap(client, plan);
            this.lastCap = plan;
        } else {
            status = await this.sendClear(client);
            if (status === 'Unknown') status = 'Accepted'; // nothing to clear is what we wanted
            this.lastCap = undefined;
        }

        // Only compliant if this is still what's wanted, on the same connection.
        if (status === 'Accepted' && wanted === this.wanted && connectionNo === this.connectionNo) {
            this.compliantSince = Date.now();
        }
        return status;
    }

    private async sendCap(client: ServerClient, plan: CapPlan): Promise<string> {
        const period = {
            startPeriod: 0,
            limit: plan.limit,
            // An amps limit is per phase; both versions assume 3 phases if this is left out.
            ...(plan.unit === 'A' && { numberPhases: this.config.phases }),
        };
        const startSchedule = new Date().toISOString();
        let res: { status: string };
        if (this._version === '1.6') {
            // 1.6 section 5.16 / 3.13: ChargePointMaxProfile on connector 0 = whole charge point.
            res = (await client.call('SetChargingProfile', {
                connectorId: 0,
                csChargingProfiles: {
                    chargingProfileId: CAP_PROFILE_ID,
                    stackLevel: 0,
                    chargingProfilePurpose: 'ChargePointMaxProfile',
                    chargingProfileKind: 'Absolute',
                    chargingSchedule: { chargingRateUnit: plan.unit, startSchedule, chargingSchedulePeriod: [period] },
                },
            })) as { status: string };
        } else {
            // 2.0.1 K01: ChargingStationMaxProfile on EVSE 0 = whole station.
            res = (await client.call('SetChargingProfile', {
                evseId: 0,
                chargingProfile: {
                    id: CAP_PROFILE_ID,
                    stackLevel: 0,
                    chargingProfilePurpose: 'ChargingStationMaxProfile',
                    chargingProfileKind: 'Absolute',
                    chargingSchedule: [{ id: 1, chargingRateUnit: plan.unit, startSchedule, chargingSchedulePeriod: [period] }],
                },
            })) as { status: string };
        }
        const unitNote = plan.unit === 'A' ? ` (${plan.allowedW} W)` : '';
        const pauseNote = plan.paused ? `, PAUSED: ${plan.requestedW} W is below ${this.config.minAmpsPerPhase} A/phase` : '';
        this.log(`${this.id} SetChargingProfile ${plan.limit} ${plan.unit}${unitNote}${pauseNote} -> ${res.status}`);
        return res.status;
    }

    private async sendClear(client: ServerClient): Promise<string> {
        // Same message in both versions; 1.6 calls the profile id `id`.
        const params = this._version === '1.6' ? { id: CAP_PROFILE_ID } : { chargingProfileId: CAP_PROFILE_ID };
        const res = (await client.call('ClearChargingProfile', params)) as { status: string };
        this.log(`${this.id} ClearChargingProfile -> ${res.status}`);
        return res.status;
    }
}

export interface ManagerOptions {
    /** Applied to every charger, over DEFAULT_CHARGER_CONFIG. */
    defaults?: Partial<ChargerConfig>;
    /** Per charger id, over `defaults`. */
    chargers?: Record<string, Partial<ChargerConfig>>;
    bootWaitMs?: number;
    /**
     * Refuse any charger id not added with expect(), at the WebSocket
     * handshake. Off by default so demos can just connect; the real program
     * turns it on, because a charger we accept but don't manage is never
     * capped and can push the site over the network's limit.
     */
    onlyKnownChargers?: boolean;
}

// A refused charger retries every few seconds; log it once a minute, not every time.
const REJECT_LOG_EVERY_MS = 60_000;

export class Manager {
    /** Every charger expected or seen since start, connected or not (see `connected`). */
    readonly chargers = new Map<string, ManagedCharger>();
    private server: RPCServer;
    private waiters = new Map<string, ((c: ManagedCharger) => void)[]>();
    private transactionNo = 0; // 1.6: the CSMS hands out transaction ids
    private lastRejectLog = new Map<string, number>(); // charger id -> when we last logged refusing it

    constructor(
        private log: (msg: string) => void = (m) => console.log(`[CSMS] ${m}`),
        private options: ManagerOptions = {},
    ) {
        // Listed in order of preference, if a charger offers both.
        this.server = new RPCServer({ protocols: ['ocpp2.0.1', 'ocpp1.6'], strictMode: true });

        // Runs during the HTTP upgrade, before the WebSocket exists: an
        // unknown charger never gets a connection, so it can't send us
        // anything or be mistaken for a managed one.
        this.server.auth((accept, reject, handshake) => {
            const id = handshake.identity;
            if (!this.options.onlyKnownChargers || this.chargers.has(id)) {
                accept(); // ocpp-rpc then picks the subprotocol as before
                return;
            }
            const now = Date.now();
            if (now - (this.lastRejectLog.get(id) ?? 0) >= REJECT_LOG_EVERY_MS) {
                this.lastRejectLog.set(id, now);
                const known = [...this.chargers.keys()].join(', ');
                this.log(
                    `REJECTED charger "${id}" from ${handshake.remoteAddress}: not a configured charger ` +
                        `(configured: ${known}; ids are case-sensitive). It is NOT being capped.`,
                );
            }
            // OCPP-J: a CSMS that doesn't recognise the identity in the URL should answer 404.
            reject(404, 'Unknown charging station identity');
        });

        this.server.on('client', (client: ServerClient) => {
            const id = client.identity!;
            const version: OcppVersion = client.protocol === 'ocpp1.6' ? '1.6' : '2.0.1';
            let charger = this.chargers.get(id);
            const returning = charger?.hasConnected ?? false;
            if (!charger) {
                charger = new ManagedCharger(id, this.configFor(id), this.log);
                this.chargers.set(id, charger);
            }
            charger.attach(client, version);
            this.log(`${id} connected (OCPP ${version})${returning ? ', reconnect' : ''}`);

            // Re-send the cap once the charger has booted, or after BOOT_WAIT_MS
            // if it doesn't boot (it only lost its connection).
            const bootTimer = setTimeout(
                () => charger.resync('reconnected without booting'),
                this.options.bootWaitMs ?? BOOT_WAIT_MS,
            );
            const onBoot = () => {
                clearTimeout(bootTimer);
                // After our reply is on the wire: a charger may not take commands before boot is accepted.
                setTimeout(() => charger.resync('booted'), 0);
            };
            const onPower = (watts: number) => addReading(charger.readings, { at: Date.now(), watts });

            if (version === '1.6') this.handle16(client, onBoot, onPower);
            else this.handle201(client, onBoot, onPower);

            client.on('close', () => {
                clearTimeout(bootTimer);
                this.log(`${id} disconnected`);
                charger.detach(client);
            });

            for (const resolve of this.waiters.get(id) ?? []) resolve(charger);
            this.waiters.delete(id);
        });
    }

    /**
     * Expect a charger: create its ManagedCharger now, before it connects, so
     * the bridge can own it from the start (it's offline until it connects).
     * With onlyKnownChargers, only expected ids are let in.
     */
    expect(id: string): ManagedCharger {
        let charger = this.chargers.get(id);
        if (!charger) {
            charger = new ManagedCharger(id, this.configFor(id), this.log);
            this.chargers.set(id, charger);
        }
        return charger;
    }

    private configFor(id: string): ChargerConfig {
        return { ...DEFAULT_CHARGER_CONFIG, ...this.options.defaults, ...this.options.chargers?.[id] };
    }

    // OCPP 1.6J: the messages a charger sends us (1.6 section 4).
    private handle16(client: ServerClient, onBoot: () => void, onPower: (w: number) => void): void {
        const now = () => new Date().toISOString();
        client.handle('BootNotification', async () => {
            onBoot();
            return { status: 'Accepted', currentTime: now(), interval: 300 };
        });
        client.handle('Heartbeat', async () => ({ currentTime: now() }));
        client.handle('StatusNotification', async () => ({}));
        // We're the only CSMS a site charger has, so we also authorise. TODO: real ID tag checks.
        client.handle('Authorize', async () => ({ idTagInfo: { status: 'Accepted' } }));
        client.handle('StartTransaction', async () => ({
            idTagInfo: { status: 'Accepted' },
            transactionId: ++this.transactionNo,
        }));
        client.handle('StopTransaction', async () => ({}));
        client.handle('DataTransfer', async () => ({ status: 'UnknownVendorId' }));
        client.handle('FirmwareStatusNotification', async () => ({}));
        client.handle('DiagnosticsStatusNotification', async () => ({}));
        // 1.6 always reports meter values in MeterValues; values are strings.
        client.handle('MeterValues', async ({ params }) => {
            for (const mv of params!.meterValue) {
                const watts = totalPowerW(
                    mv.sampledValue.map((sv: { value: string; measurand?: string; phase?: string; unit?: string }) => ({
                        measurand: sv.measurand,
                        phase: sv.phase,
                        watts: Number(sv.value) * (sv.unit === 'kW' ? 1000 : 1),
                    })),
                );
                if (watts !== undefined && Number.isFinite(watts)) onPower(watts);
            }
            return {};
        });
    }

    // OCPP 2.0.1.
    private handle201(client: ServerClient, onBoot: () => void, onPower: (w: number) => void): void {
        const now = () => new Date().toISOString();
        client.handle('BootNotification', async () => {
            onBoot();
            return { currentTime: now(), interval: 300, status: 'Accepted' };
        });
        client.handle('Heartbeat', async () => ({ currentTime: now() }));
        client.handle('StatusNotification', async () => ({}));
        client.handle('Authorize', async () => ({ idTokenInfo: { status: 'Accepted' } }));
        client.handle('NotifyEvent', async () => ({}));
        client.handle('NotifyReport', async () => ({}));
        client.handle('SecurityEventNotification', async () => ({}));
        client.handle('FirmwareStatusNotification', async () => ({}));
        client.handle('LogStatusNotification', async () => ({}));

        type SampledValue201 = {
            value: number;
            measurand?: string;
            phase?: string;
            unitOfMeasure?: { unit?: string; multiplier?: number };
        };
        const readMeterValues = (meterValue: { sampledValue: SampledValue201[] }[] | undefined) => {
            for (const mv of meterValue ?? []) {
                const watts = totalPowerW(
                    mv.sampledValue.map((sv) => ({
                        measurand: sv.measurand,
                        phase: sv.phase,
                        watts:
                            sv.value *
                            (sv.unitOfMeasure?.unit === 'kW' ? 1000 : 1) *
                            10 ** (sv.unitOfMeasure?.multiplier ?? 0),
                    })),
                );
                if (watts !== undefined) onPower(watts);
            }
        };
        // During a transaction meter values come in TransactionEvent; outside one, in MeterValues.
        client.handle('TransactionEvent', async ({ params }) => {
            readMeterValues(params!.meterValue);
            return {};
        });
        client.handle('MeterValues', async ({ params }) => {
            readMeterValues(params!.meterValue);
            return {};
        });
    }

    async listen(port = 9000): Promise<void> {
        await this.server.listen(port);
        this.log(`listening on ws://localhost:${port}`);
    }

    /** Resolves when the charger is connected (now, or when it next connects). */
    waitForCharger(id: string): Promise<ManagedCharger> {
        const existing = this.chargers.get(id);
        if (existing?.connected) return Promise.resolve(existing);
        return new Promise((resolve) => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]));
    }

    async close(): Promise<void> {
        await this.server.close({ awaitPending: true });
    }
}
