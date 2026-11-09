// CSIP-AUS gateway client (small subset of IEEE 2030.5).
//
// Walks the server's resources, reads the default control and the
// scheduled controls, and says which import limit applies right now.
// Check it with: npm run check-csip
//
// Also posts telemetry: registerMirror() once, then postReading() every
// postRate (see mirrorXml.ts for the XML).
//
// Not handled yet: certificates/TLS, registering the device (POST /edev),
// posting responses, multiple programs and primacy, overlapping controls,
// randomizeStart, list paging.
import xml2js from 'xml2js';
import {
    mirrorMeterReadingXml,
    mirrorUsagePointXml,
    PLACEHOLDER_PEN,
    type MirrorKind,
    type MirrorReading,
} from './mirrorXml.js';
import type { ActiveLimit, LimitSource } from './limitSource.js';

export type { ActiveLimit } from './limitSource.js';

export interface CsipClientOptions {
    // The device maker's IANA Private Enterprise Number as 8 hex digits (see
    // penHex() in mirrorXml.ts). Ends every mRID the client creates.
    pen?: string;
}

// Parsed XML from xml2js: plain objects, attributes under `$`, all text as
// strings. Shapes differ between servers, so it stays loosely typed here and
// gets turned into proper types as soon as it's read.
type Xml = any;

const REQUEST_TIMEOUT_MS = 10_000;
// Used when the server's MirrorUsagePoint doesn't say (SEP2 Client Handbook default).
const DEFAULT_POST_RATE_SEC = 300;

interface Control {
    mRID: string;
    start: number; // unix seconds, server clock
    end: number; // start + duration; the control is active while start <= now < end
    importLimitW: number | undefined; // undefined if this control doesn't set an import limit
}

export class CsipClient implements LimitSource {
    // Links found by discover().
    private tmHref?: string;
    private ddercHref?: string; // may stay undefined: not every program has a default
    private dercHref?: string;
    private mupListHref?: string; // where to register telemetry; undefined if the server takes none
    private lFDI?: string; // our EndDevice's certificate fingerprint

    // Our MirrorUsagePoints, from registerMirror().
    private mirrorHrefs = new Map<MirrorKind, string>();
    private readonly pen: string;

    // State from the last poll().
    lastUpdatedAt = 0; // ms since epoch of the last good poll; 0 = never
    private clockOffsetSec = 0; // server clock minus local clock: our best estimate
    // How far it can be out: the true offset is in [clockOffsetSec - early, clockOffsetSec + late].
    private clockEarlySec = 0;
    private clockLateSec = 0;
    private defaultLimitW: number | undefined;
    private controls: Control[] = [];

    constructor(
        private readonly baseUrl: string,
        opts: CsipClientOptions = {},
    ) {
        this.pen = opts.pen ?? PLACEHOLDER_PEN;
        if (!/^[0-9A-F]{8}$/.test(this.pen)) throw new Error(`pen must be 8 upper-case hex digits, got "${this.pen}"`);
    }

    /** Walk dcap -> edev -> fsa -> derp once and remember the links we need. */
    async discover(): Promise<void> {
        const dcap = await this.getRequired('/dcap');
        this.tmHref = dcap.TimeLink?.$?.href;
        this.mupListHref = dcap.MirrorUsagePointListLink?.$?.href;

        // The pre-registered gateway is the first EndDevice. A real client
        // would pick the one whose lFDI matches its own certificate.
        const edevList = await this.getRequired(href(dcap.EndDeviceListLink, 'EndDeviceListLink'));
        const edev = first(edevList.EndDevice, 'EndDevice');
        this.lFDI = edev.lFDI;

        const fsaList = await this.getRequired(href(edev.FunctionSetAssignmentsListLink, 'FunctionSetAssignmentsListLink'));
        const fsa = first(fsaList.FunctionSetAssignments, 'FunctionSetAssignments');
        this.tmHref ??= fsa.TimeLink?.$?.href;

        const derpList = await this.getRequired(href(fsa.DERProgramListLink, 'DERProgramListLink'));
        const derp = first(derpList.DERProgram, 'DERProgram');
        this.ddercHref = derp.DefaultDERControlLink?.$?.href;
        this.dercHref = href(derp.DERControlListLink, 'DERControlListLink');

        if (!this.tmHref) throw new Error('server gave no TimeLink');
    }

    /** For LimitSource: discover() until it has worked once, then poll(). */
    async refresh(): Promise<void> {
        if (!this.dercHref) await this.discover();
        await this.poll();
    }

    /** Re-read the server clock, the default control and the control list. */
    async poll(): Promise<void> {
        if (!this.tmHref || !this.dercHref) throw new Error('call discover() first');

        // Fetch everything first and only then update our state, so a poll that
        // fails halfway (link drops) leaves the last good state untouched
        // rather than a mix of old and new.
        const askedAt = Date.now() / 1000;
        const tm = await this.getRequired(this.tmHref);
        const fetchedAt = Date.now() / 1000;
        // A 404 here is normal: the program has no default control.
        const dderc = this.ddercHref ? await this.get(this.ddercHref) : undefined;
        const list = await this.getRequired(this.dercHref);

        // /tm rounds down to whole seconds, and the server read its clock some
        // time between our request and its reply. So when the reply arrived,
        // the server's clock was somewhere in [currentTime, currentTime + 1 +
        // round trip). Our estimate is currentTime + 0.5, and we keep how far
        // it can be out, so activeImportLimit() can be careful near a boundary.
        const roundTripSec = fetchedAt - askedAt;
        this.clockOffsetSec = Number(tm.currentTime) + 0.5 - fetchedAt;
        this.clockEarlySec = 0.5;
        this.clockLateSec = 0.5 + roundTripSec;
        this.defaultLimitW = watts(dderc?.DERControlBase?.opModImpLimW);
        this.controls = toArray<Xml>(list.DERControl).map((c) => {
            const start = Number(c.interval.start);
            return {
                mRID: c.mRID,
                start,
                end: start + Number(c.interval.duration),
                importLimitW: watts(c.DERControlBase?.opModImpLimW),
            };
        });
        this.lastUpdatedAt = Date.now();
    }

    /** The import limit that applies now, from the last poll(). No network calls. */
    //
    // We only know the server's time to within a second or so (see poll()).
    // Near a control's start or end either limit might apply, so take every
    // limit that might apply right now and use the lowest. A tighter control
    // then starts as soon as it might have started and ends only once it has
    // certainly ended (and a looser one starts late and ends early): never
    // over whichever limit the server meant.
    activeImportLimit(): ActiveLimit {
        const now = Date.now() / 1000;
        const earliest = now + this.clockOffsetSec - this.clockEarlySec;
        const latest = now + this.clockOffsetSec + this.clockLateSec;

        const candidates = [this.limitAt(earliest), this.limitAt(latest)];
        // A control short enough to fit between the two doesn't show at either end.
        for (const c of this.controls) {
            if (c.importLimitW !== undefined && c.start <= latest && earliest < c.end) {
                candidates.push({ importLimitW: c.importLimitW, source: 'control', mRID: c.mRID });
            }
        }
        // No limit at all is the loosest; on a tie, the first (earliest) one.
        const strictness = (l: ActiveLimit) => l.importLimitW ?? Infinity;
        return candidates.reduce((best, l) => (strictness(l) < strictness(best) ? l : best));
    }

    // The limit at one server time, as if we knew it exactly.
    private limitAt(serverSec: number): ActiveLimit {
        // Decide from start/end, not EventStatus: that was only true at poll time.
        // A control that doesn't set an import limit leaves the default in charge
        // of import. If controls overlap, the first one wins (good enough for now;
        // the real rule is that the most recently created one wins).
        const active = this.controls.find(
            (c) => c.importLimitW !== undefined && c.start <= serverSec && serverSec < c.end,
        );
        if (active) return { importLimitW: active.importLimitW, source: 'control', mRID: active.mRID };
        return this.defaultImportLimit();
    }

    /** The default control from the last good poll, ignoring scheduled controls. No network calls. */
    defaultImportLimit(): ActiveLimit {
        if (this.defaultLimitW !== undefined) return { importLimitW: this.defaultLimitW, source: 'default' };
        return { importLimitW: undefined, source: 'none' };
    }

    /** True if discover() found somewhere to post telemetry. */
    get takesTelemetry(): boolean {
        return this.mupListHref !== undefined;
    }

    /** Server time in unix seconds for a local time (default now), from the last good poll's clock offset. */
    serverTimeSec(localMs = Date.now()): number {
        return localMs / 1000 + this.clockOffsetSec;
    }

    /** The local time in ms for a server time in unix seconds. The reverse of serverTimeSec(). */
    localTimeMs(serverSec: number): number {
        return (serverSec - this.clockOffsetSec) * 1000;
    }

    /**
     * Register one of our MirrorUsagePoints (POST to the MirrorUsagePointList)
     * and return how often the server wants readings, in seconds. Safe to call
     * again: the mRID never changes, so the server updates the same mirror.
     */
    async registerMirror(kind: MirrorKind): Promise<number> {
        if (!this.mupListHref || !this.lFDI) {
            throw new Error('no MirrorUsagePointListLink or lFDI (call discover() first)');
        }
        const res = await this.post(this.mupListHref, mirrorUsagePointXml(kind, this.lFDI, this.pen));
        // The server says where it put our mirror; readings go there.
        const location = res.headers.get('location');
        if (!location) throw new Error(`POST ${this.mupListHref} gave no Location header`);
        // The mirror as the server stores it carries the postRate.
        const mup = await this.getRequired(location);
        this.mirrorHrefs.set(kind, location);
        const postRate = Number(mup.postRate ?? DEFAULT_POST_RATE_SEC);
        return postRate > 0 ? postRate : DEFAULT_POST_RATE_SEC;
    }

    /** Post one average-power reading to one of our MirrorUsagePoints. Throws on any failure. */
    async postReading(kind: MirrorKind, reading: MirrorReading): Promise<void> {
        const href = this.mirrorHrefs.get(kind);
        if (!href) throw new Error(`call registerMirror('${kind}') first`);
        await this.post(href, mirrorMeterReadingXml(kind, this.pen, reading));
    }

    /** POST an XML document. Throws unless the server answers 2xx. */
    private async post(path: string, xml: string): Promise<Response> {
        const url = new URL(path, this.baseUrl);
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sep+xml' },
            body: xml,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // Read the (usually empty) body so the connection is released for reuse.
        await res.text();
        if (!res.ok) throw new Error(`POST ${url.pathname} -> HTTP ${res.status}`);
        return res;
    }

    /** GET a resource and parse it. Returns undefined on 404, throws on other errors. */
    private async get(path: string): Promise<Xml | undefined> {
        // hrefs are paths like "/edev"; resolve them against the server address.
        const url = new URL(path, this.baseUrl);
        // Without a timeout, a link that goes silent (rather than refusing the
        // connection) would leave the request, and the poll, waiting forever.
        const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (res.status === 404) return undefined;
        if (!res.ok) throw new Error(`GET ${url.pathname} -> HTTP ${res.status}`);

        const parsed = await xml2js.parseStringPromise(await res.text(), {
            explicitArray: false, // single children as objects, not 1-item arrays
            tagNameProcessors: [xml2js.processors.stripPrefix], // "csipaus:x" and "ns2:x" both become "x"
        });
        // The document has one root element (DeviceCapability, Time, ...).
        // Return what's inside it so callers don't need to know its name.
        return Object.values(parsed)[0];
    }

    /** Like get(), but a 404 is an error. */
    private async getRequired(path: string): Promise<Xml> {
        const doc = await this.get(path);
        if (doc === undefined) throw new Error(`GET ${path} -> 404`);
        return doc;
    }
}

/** The href attribute of a *Link element, or an error naming what's missing. */
function href(link: Xml, name: string): string {
    const h = link?.$?.href;
    if (!h) throw new Error(`server gave no ${name}`);
    return h;
}

/** The first item of a list element, or an error naming what's missing. */
function first(items: Xml, name: string): Xml {
    const item = toArray<Xml>(items)[0];
    if (item === undefined) throw new Error(`server listed no ${name}`);
    return item;
}

/** CSIP-AUS power is { value, multiplier } with watts = value * 10^multiplier. */
function watts(activePower: Xml): number | undefined {
    if (activePower === undefined) return undefined;
    return Number(activePower.value) * 10 ** Number(activePower.multiplier ?? 0);
}

// xml2js gives a single child as an object and several as an array.
// This always gives back an array so callers can loop over it.
function toArray<T>(x: T | T[] | undefined): T[] {
    if (x === undefined) return [];
    if (Array.isArray(x)) return x;
    return [x];
}
