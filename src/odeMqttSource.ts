// Limit source: Open Dynamic Export's MQTT output.
//
// ODE (github.com/longzheng/open-dynamic-export) does the CSIP-AUS side for
// real: TLS, certificates, registration, network certification. With
// `publish.mqtt` in its config it publishes, about once a second and not
// retained, a JSON message on `<topic>/csipAus`:
//
//   { "limit": { "source": "csipAus", "opModImpLimW": 3000, ... },
//     "setGradW": 27,
//     "schedules": { "opModImpLimW": [ { "mRID": "...",
//         "effectiveStartInclusive": "2026-10-23T07:00:00.000Z",
//         "effectiveEndExclusive": "2026-10-23T09:00:00.000Z", ... } ], ... } }
//
// `limit.opModImpLimW` is ODE's answer to "what's the network's import limit
// right now", in W: the active control, else the default control, else ODE's
// configured fixedDefault. Absent (JSON drops undefined) means no limit.
// Full format and source references: plans/notes/tab-a.md.
//
// Why this topic and not the main `<topic>` one: the main one merges all of
// ODE's limit sources (fixed config, tariffs, ...) and can't tell a control
// from the default, so we couldn't do the fail-safe. This one has the
// schedules, which tell us whether a control is active.
//
// The default: ODE doesn't publish the default control on its own, so we
// learn it. Whenever no control is anywhere near active, the limit ODE sends
// *is* the default (or ODE's fixedDefault), so we remember it. If we never
// saw one (e.g. we started mid-control), `fallbackImportLimitW` is used.
//
// Fail-safe: the bridge does it, as for CsipClient. We set lastUpdatedAt on
// every valid message; if none arrives for commsLostAfterMs (ODE crashed,
// broker down, network cable), the bridge applies defaultImportLimit().
//
// Validation: every message is checked before it's used. A bad one is
// logged and dropped: it changes nothing and doesn't count as "alive".
import mqtt from 'mqtt';
import type { ActiveLimit, LimitSource } from './limitSource.js';

export interface OdeMqttSourceOptions {
    url: string; // the broker, e.g. mqtt://localhost:1883 (ODE's publish.mqtt.host)
    topic: string; // ODE's publish.mqtt.topic
    csipAusTopic?: string; // ODE's publish.mqtt.csipAus; ODE's default is `<topic>/csipAus`
    username?: string;
    password?: string;
    // No valid message for this long -> comms lost. ODE publishes about every
    // second, so the default allows ~10 missed messages.
    commsLostAfterMs?: number;
    // Used as the default if ODE never showed us one. Omit: no default, so the
    // bridge removes caps on comms loss (same as CsipClient without a default).
    fallbackImportLimitW?: number;
    log?: (msg: string) => void;
}

/** What we take from one ODE csipAus message, after checking it. */
export interface OdeCsipAusMessage {
    importLimitW: number | undefined; // undefined = no import limit
    importControls: { mRID: string; start: number; end: number }[]; // ms since epoch, end exclusive
}

const DEFAULT_COMMS_LOST_AFTER_MS = 10_000;
// At boot, how long refresh() waits for ODE's first message (it isn't
// retained, so we wait for the next one).
const FIRST_MESSAGE_WAIT_MS = 3000;
// Only learn the default when no control starts or ends within this much
// time. Near a boundary ODE's clock and ours may disagree, and ODE may still
// be ramping between the control and the default.
const DEFAULT_LEARN_MARGIN_MS = 5000;
// Log at most one "bad message" line this often, so a broken publisher
// can't flood the log.
const BAD_MESSAGE_LOG_EVERY_MS = 30_000;

export class OdeMqttSource implements LimitSource {
    lastUpdatedAt = 0;
    readonly commsLostAfterMs: number;
    readonly csipAusTopic: string;
    rejectedMessages = 0; // for the demo and for status pages

    private client?: mqtt.MqttClient;
    private connected = false; // only used to log the moment it changes
    private lastError?: string; // ditto, so retries don't repeat the same error
    private latest?: ActiveLimit; // from the last valid message
    private learnedDefault?: { importLimitW: number | undefined };
    private lastBadLogAt = 0;
    private badSinceLastLog = 0;
    private log: (msg: string) => void;

    constructor(private readonly opts: OdeMqttSourceOptions) {
        this.csipAusTopic = opts.csipAusTopic ?? `${opts.topic}/csipAus`;
        this.commsLostAfterMs = opts.commsLostAfterMs ?? DEFAULT_COMMS_LOST_AFTER_MS;
        const fallback = opts.fallbackImportLimitW;
        if (fallback !== undefined && !(Number.isFinite(fallback) && fallback >= 0)) {
            throw new Error(`fallbackImportLimitW must be a number >= 0, got ${fallback}`);
        }
        this.log = opts.log ?? ((m) => console.log(`[ODE-MQTT] ${m}`));
    }

    /** Connect to the broker and subscribe. Returns at once; mqtt.js keeps reconnecting by itself. */
    start(): void {
        if (this.client) return;
        this.client = mqtt.connect(this.opts.url, {
            username: this.opts.username,
            password: this.opts.password,
            reconnectPeriod: 1000,
            connectTimeout: 5000,
            // We subscribe on every 'connect' ourselves, so one place does it.
            resubscribe: false,
        });
        this.client.on('connect', () => {
            if (!this.connected) this.log(`connected to ${this.opts.url}, subscribing to ${this.csipAusTopic}`);
            this.connected = true;
            this.lastError = undefined;
            this.client!.subscribe(this.csipAusTopic, (err) => {
                if (err) this.log(`subscribe failed: ${err.message}`);
            });
        });
        this.client.on('close', () => {
            if (this.connected && this.client) this.log('broker connection lost, reconnecting');
            this.connected = false;
        });
        this.client.on('error', (err) => {
            // Each reconnect attempt fails the same way; say it once. (Connection
            // refused on Windows is an AggregateError with an empty message.)
            const text = err.message || (err as NodeJS.ErrnoException).code || String(err);
            if (text !== this.lastError) this.log(`mqtt error: ${text}`);
            this.lastError = text;
        });
        this.client.on('message', (topic, payload) => {
            if (topic === this.csipAusTopic) this.onMessage(payload.toString('utf8'));
        });
    }

    async stop(): Promise<void> {
        const client = this.client;
        this.client = undefined; // so 'close' doesn't log a lost connection
        await client?.endAsync();
    }

    /**
     * Messages arrive by themselves, so there's nothing to fetch. This only
     * says whether they still are: throws if no valid message for
     * commsLostAfterMs. At boot, waits briefly for the first one, so the
     * bridge starts with a real limit.
     */
    async refresh(): Promise<void> {
        if (this.lastUpdatedAt === 0) {
            const until = Date.now() + FIRST_MESSAGE_WAIT_MS;
            while (this.lastUpdatedAt === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
        }
        const ageMs = Date.now() - this.lastUpdatedAt;
        if (ageMs > this.commsLostAfterMs) {
            throw new Error(this.lastUpdatedAt === 0
                ? `no valid ODE message on ${this.csipAusTopic} yet`
                : `no valid ODE message on ${this.csipAusTopic} for ${Math.round(ageMs / 1000)} s`);
        }
    }

    activeImportLimit(): ActiveLimit {
        return this.latest ?? this.defaultImportLimit();
    }

    defaultImportLimit(): ActiveLimit {
        const w = this.learnedDefault ? this.learnedDefault.importLimitW : this.opts.fallbackImportLimitW;
        return w === undefined ? { importLimitW: undefined, source: 'none' } : { importLimitW: w, source: 'default' };
    }

    // Public so a test can feed it messages without a broker.
    onMessage(text: string, now = Date.now()): void {
        let msg: OdeCsipAusMessage;
        try {
            msg = parseOdeCsipAusMessage(text);
        } catch (err) {
            this.rejectedMessages++;
            this.badSinceLastLog++;
            if (now - this.lastBadLogAt >= BAD_MESSAGE_LOG_EVERY_MS) {
                const more = this.badSinceLastLog > 1 ? ` (${this.badSinceLastLog} bad since last report)` : '';
                this.log(`ignored bad message on ${this.csipAusTopic}: ${(err as Error).message}${more}`);
                this.lastBadLogAt = now;
                this.badSinceLastLog = 0;
            }
            return;
        }

        const active = msg.importControls.find((c) => c.start <= now && now < c.end);
        this.latest = active
            ? { importLimitW: msg.importLimitW, source: 'control', mRID: active.mRID }
            : msg.importLimitW === undefined
              ? { importLimitW: undefined, source: 'none' }
              : { importLimitW: msg.importLimitW, source: 'default' };

        const nearControl = msg.importControls.some(
            (c) => c.start - DEFAULT_LEARN_MARGIN_MS <= now && now < c.end + DEFAULT_LEARN_MARGIN_MS,
        );
        if (!nearControl) {
            if (!this.learnedDefault || this.learnedDefault.importLimitW !== msg.importLimitW) {
                this.log(`default import limit is ${msg.importLimitW === undefined ? 'none' : `${msg.importLimitW} W`}`);
            }
            this.learnedDefault = { importLimitW: msg.importLimitW };
        }
        this.lastUpdatedAt = now;
    }
}

/**
 * Check one ODE csipAus message and pull out what we use. Throws on anything
 * we can't trust; the caller then ignores the whole message. Strict on the
 * fields we use, relaxed on the rest (ODE may add fields).
 */
export function parseOdeCsipAusMessage(text: string): OdeCsipAusMessage {
    let msg: unknown;
    try {
        msg = JSON.parse(text);
    } catch {
        throw new Error('not JSON');
    }
    if (!isObject(msg)) throw new Error('not a JSON object');
    if (!isObject(msg.limit)) throw new Error('no "limit" object');

    // Missing = no import limit (ODE's JSON.stringify drops undefined). Null
    // isn't something ODE sends, so treat it as broken rather than guess.
    const w = msg.limit.opModImpLimW;
    if (w !== undefined && !(typeof w === 'number' && Number.isFinite(w) && w >= 0)) {
        throw new Error(`limit.opModImpLimW must be a number >= 0 (W), got ${JSON.stringify(w)}`);
    }

    if (!isObject(msg.schedules)) throw new Error('no "schedules" object');
    const schedules = msg.schedules.opModImpLimW;
    if (!Array.isArray(schedules)) throw new Error('schedules.opModImpLimW is not an array');
    const importControls = schedules.map((s: unknown, i) => {
        if (!isObject(s) || typeof s.mRID !== 'string') throw new Error(`schedules.opModImpLimW[${i}] has no mRID`);
        // Effective times include ODE's randomisation, so they're when ODE
        // actually switches.
        const start = isoTime(s.effectiveStartInclusive);
        const end = isoTime(s.effectiveEndExclusive);
        if (start === undefined || end === undefined || end < start) {
            throw new Error(`schedules.opModImpLimW[${i}] has bad effective start/end times`);
        }
        return { mRID: s.mRID, start, end };
    });

    return { importLimitW: w, importControls };
}

function isObject(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// ODE's dates are JSON.stringify'd Dates: ISO 8601 strings in UTC.
function isoTime(x: unknown): number | undefined {
    if (typeof x !== 'string') return undefined;
    const ms = Date.parse(x);
    return Number.isNaN(ms) ? undefined : ms;
}
