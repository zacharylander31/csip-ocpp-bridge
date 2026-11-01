// Site meter: what Open Dynamic Export's meter reads, from ODE's REST API.
//
// ODE already reads the site's meter to control solar export, and the
// installer has set that meter up in ODE's config. ODE doesn't publish it over
// MQTT (only limits), but GET /api/coordinator/status returns its latest sample:
//
//   { "running": true,
//     "siteSample": { "date": "2026-11-02T01:00:00.000Z",
//                     "realPower": { "type": "noPhase", "net": 1200 }, ... }, ... }
//
// `realPower.net` is in W: positive = site importing, negative = exporting,
// the same way round as Bridge's house load. Source references and the
// reasons for choosing this over reading Modbus: plans/notes/site-meter.md.
//
// A meter that dies doesn't look dead: ODE keeps returning its last good
// sample. So a sample only counts if its `date` has changed since the last
// one. Comparing dates with each other, not with our clock, means ODE on
// another box with a different clock is fine.
//
// Exception: ODE's "mqtt" meter type stamps a new date on the last message it
// got every time it's read, so if THAT meter dies we can't tell. ODE's
// sunspec, sma and powerwall2 meters stamp the date when they read the meter.
import { addReading, type Metered, type PowerReading } from './csms.js';

export const ODE_STATUS_PATH = '/api/coordinator/status';

// A sample is already this old, at most, when we fetch it (ODE reads its meter
// every 200 ms by default). Bridge only trusts site readings taken after the
// chargers settled, so a reading is stamped as if taken this long before we
// asked: claiming to be newer than it is would let a pre-change sample through.
const SAMPLE_MAX_AGE_MS = 1000;
const MIN_REQUEST_TIMEOUT_MS = 2000;

export interface OdeSiteMeterOptions {
    url: string; // ODE's address, e.g. http://open-dynamic-export:3000
    pollMs?: number;
    log?: (msg: string) => void;
}

export class OdeSiteMeter implements Metered {
    readonly id = 'site';
    readonly readings: PowerReading[] = [];
    private statusUrl: string;
    private pollMs: number;
    private log: (msg: string) => void;
    private running = false;
    private loop?: Promise<void>;
    private lastDateMs?: number;
    private lastProblem?: string; // only used to log the moment it changes
    private abort?: AbortController;

    constructor(opts: OdeSiteMeterOptions) {
        this.statusUrl = new URL(ODE_STATUS_PATH, opts.url).href;
        this.pollMs = opts.pollMs ?? 1000;
        this.log = opts.log ?? ((m) => console.log(`[ODE-METER] ${m}`));
    }

    /** Start polling. Returns at once and never throws: ODE may not be up yet. */
    start(): void {
        if (this.running) return;
        this.running = true;
        this.loop = this.pollLoop();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.abort?.abort();
        await this.loop;
    }

    // A loop with await, not setInterval, so a slow ODE can't pile up requests.
    private async pollLoop(): Promise<void> {
        while (this.running) {
            const startedAt = Date.now();
            await this.pollOnce(startedAt);
            const wait = this.pollMs - (Date.now() - startedAt);
            if (this.running && wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
    }

    private async pollOnce(askedAt: number): Promise<void> {
        let sample: OdeSiteSample;
        try {
            this.abort = new AbortController();
            const timer = setTimeout(() => this.abort?.abort(), Math.max(this.pollMs, MIN_REQUEST_TIMEOUT_MS));
            try {
                const res = await fetch(this.statusUrl, { signal: this.abort.signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                sample = parseOdeStatus(await res.text());
            } finally {
                clearTimeout(timer);
            }
        } catch (err) {
            if (!this.running) return; // stop() cut it short
            this.report(`couldn't read the site meter from ${this.statusUrl}: ${describe(err)}`);
            return;
        }

        if (this.lastProblem) this.log('reading the site meter from ODE again');
        this.lastProblem = undefined;

        // The first sample only sets the baseline: it could be from a meter
        // that died long ago. Same date as last time: nothing new was read.
        const isNew = this.lastDateMs !== undefined && sample.dateMs !== this.lastDateMs;
        this.lastDateMs = sample.dateMs;
        if (isNew) addReading(this.readings, { at: askedAt - SAMPLE_MAX_AGE_MS, watts: sample.watts });
    }

    // Polled every second: say each problem once, not every time.
    private report(problem: string): void {
        if (problem !== this.lastProblem) this.log(problem);
        this.lastProblem = problem;
    }
}

export interface OdeSiteSample {
    dateMs: number;
    watts: number; // positive = importing, negative = exporting
}

/**
 * Check ODE's status response and pull out the site sample. Throws on anything
 * we can't trust: a wrong number here would hand the chargers power the site
 * doesn't have. Strict on the fields we use, relaxed on the rest.
 */
export function parseOdeStatus(text: string): OdeSiteSample {
    let status: unknown;
    try {
        status = JSON.parse(text);
    } catch {
        throw new Error('not JSON');
    }
    if (!isObject(status)) throw new Error('not a JSON object');
    if (status.running !== true) throw new Error("ODE's coordinator isn't running");
    const sample = status.siteSample;
    // null until ODE's first good meter read.
    if (sample === null) throw new Error('ODE has no site sample yet (is its meter connected?)');
    if (!isObject(sample)) throw new Error('no "siteSample" object');
    const dateMs = typeof sample.date === 'string' ? Date.parse(sample.date) : NaN;
    if (Number.isNaN(dateMs)) throw new Error(`siteSample.date must be a date, got ${JSON.stringify(sample.date)}`);
    const net = isObject(sample.realPower) ? sample.realPower.net : undefined;
    if (typeof net !== 'number' || !Number.isFinite(net)) {
        throw new Error(`siteSample.realPower.net must be a number (W), got ${JSON.stringify(net)}`);
    }
    return { dateMs, watts: net };
}

function isObject(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// fetch() says only "fetch failed"; the useful part is in `cause`. (Connection
// refused on Windows is an AggregateError with an empty message, so use its code.)
function describe(err: unknown): string {
    const e = err as Error & { cause?: Error & { code?: string } };
    if (e.name === 'AbortError') return 'timed out';
    return e.cause?.code ?? (e.cause?.message || e.message);
}
