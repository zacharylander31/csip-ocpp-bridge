// Mock CSIP-AUS utility server (a small subset of IEEE 2030.5).
//
// Plain HTTP, no certificates, one pre-registered gateway, one DER program.
// XML shapes copy real responses (SA Power Networks, Energy Queensland)
// captured in Open Dynamic Export's tests/sep2/mocks.
//
// The resource walk a gateway client does:
//   GET /dcap                -> DeviceCapability   (links to /tm and /edev)
//   GET /tm                  -> Time               (the server's clock)
//   GET /edev                -> EndDeviceList      (our gateway: /edev/1)
//   GET /edev/1/fsa          -> FunctionSetAssignmentsList
//   GET /edev/1/fsa/1/derp   -> DERProgramList     (links to dderc and derc)
//   GET /derp/1/dderc        -> DefaultDERControl  (fallback limits)
//   GET /derp/1/derc         -> DERControlList     (scheduled limits)
//
// Telemetry (the gateway pushes readings to the server):
//   POST /mup                -> 201 + Location: /mup/N  (register a MirrorUsagePoint)
//   GET  /mup/N              -> MirrorUsagePoint   (tells the gateway its postRate)
//   POST /mup/N              -> 201                (one MirrorMeterReading)
import http from 'node:http';
import xml2js from 'xml2js';

export interface ActivePower {
    value: number;
    multiplier: number; // power of ten: watts = value * 10^multiplier
}

export interface MockControl {
    mRID: string;
    start: number; // unix seconds, server clock
    duration: number; // seconds
    importLimit: ActivePower; // csipaus:opModImpLimW
}

export interface Scenario {
    defaultImportLimit?: ActivePower; // omit for "no default control"
    controls: MockControl[];
    // Real servers use different prefixes for the same namespace
    // (SAPN: "csipaus", Energy Queensland: "ns2").
    nsPrefix?: string;
    // Seconds the server clock is ahead of this machine's clock.
    clockOffsetSec?: number;
    pollRateSec?: number;
    // How often the gateway should post telemetry (MirrorUsagePoint postRate).
    mupPostRateSec?: number;
}

/** One telemetry reading the server received, for checking afterwards. */
export interface ReceivedReading {
    mirrorHref: string; // which MirrorUsagePoint it was posted to
    mRID: string;
    watts: number; // value * 10^powerOfTenMultiplier
    start: number; // timePeriod.start, unix seconds
    duration: number; // timePeriod.duration, seconds
    receivedAt: number; // ms since epoch
}

export interface Mirror {
    mRID: string;
    description: string;
    roleFlags: string;
    deviceLFDI: string;
}

const SEP = 'urn:ieee:std:2030.5:ns';
const CSIPAUS = 'https://csipaus.org/ns';
// The pre-registered gateway's certificate fingerprint.
const GATEWAY_LFDI = '3E4F45AB31EDFE5B67E343E5E4562E31984E23E5';

export class MockCsipServer {
    private server: http.Server;
    private scenario: Scenario;
    private log: (msg: string) => void;
    private offline = false;

    // Telemetry state.
    readonly telemetry: ReceivedReading[] = [];
    private mirrors = new Map<number, Mirror>(); // by N in /mup/N
    private nextMirrorId = 1;

    constructor(scenario: Scenario, log: (msg: string) => void = (m) => console.log(`[CSIP] ${m}`)) {
        this.scenario = scenario;
        this.log = log;
        this.server = http.createServer((req, res) => {
            this.route(req, res).catch((err) => {
                this.log(`error handling ${req.method} ${req.url}: ${(err as Error).message}`);
                res.writeHead(500).end();
            });
        });
    }

    setScenario(scenario: Scenario): void {
        this.scenario = scenario;
    }

    // Simulate the network link dropping: requests get their connection cut
    // with no response, as if the line went dead.
    setOffline(offline: boolean): void {
        this.offline = offline;
        this.log(offline ? 'link DOWN' : 'link UP');
    }

    // Simulate the server deleting the gateway's MirrorUsagePoints (Energex
    // told Open Dynamic Export this can happen). Readings posted to them then
    // get 404 until the gateway registers again.
    forgetMirrors(): void {
        this.mirrors.clear();
        this.log('forgot all MirrorUsagePoints');
    }

    /** The MirrorUsagePoints registered right now, by href. */
    registeredMirrors(): Map<string, Mirror> {
        return new Map([...this.mirrors].map(([id, m]) => [`/mup/${id}`, m]));
    }

    serverNow(): number {
        return Math.floor(Date.now() / 1000) + (this.scenario.clockOffsetSec ?? 0);
    }

    listen(port = 8080): Promise<void> {
        return new Promise((resolve) =>
            this.server.listen(port, () => {
                this.log(`listening on http://localhost:${port}/dcap`);
                resolve();
            }),
        );
    }

    close(): Promise<void> {
        this.server.closeAllConnections();
        return new Promise((resolve) => this.server.close(() => resolve()));
    }

    private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (this.offline) {
            req.socket.destroy();
            return;
        }
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        if (req.method === 'POST') {
            const { status, location } = await this.post(path, await readBody(req));
            this.log(`POST ${path} -> ${status}${location ? ` (Location: ${location})` : ''}`);
            res.writeHead(status, location ? { Location: location } : {}).end();
            return;
        }
        const body = req.method === 'GET' ? this.resource(path) : undefined;
        this.log(`${req.method} ${path} -> ${body ? 200 : 404}`);
        if (!body) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/sep+xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`);
    }

    private async post(path: string, body: string): Promise<{ status: number; location?: string }> {
        let doc: Xml;
        try {
            doc = await xml2js.parseStringPromise(body, {
                explicitArray: false,
                tagNameProcessors: [xml2js.processors.stripPrefix],
            });
        } catch {
            return { status: 400 };
        }

        if (path === '/mup' && doc.MirrorUsagePoint) {
            const mup = doc.MirrorUsagePoint;
            // A gateway may only mirror itself.
            if (mup.deviceLFDI !== GATEWAY_LFDI) return { status: 400 };
            // Posting an mRID the server already has updates that mirror
            // rather than making a second one, so it gets the same Location.
            for (const [id, m] of this.mirrors) {
                if (m.mRID === mup.mRID) return { status: 204, location: `/mup/${id}` };
            }
            const id = this.nextMirrorId++;
            this.mirrors.set(id, {
                mRID: mup.mRID,
                description: mup.description ?? '',
                roleFlags: mup.roleFlags,
                deviceLFDI: mup.deviceLFDI,
            });
            return { status: 201, location: `/mup/${id}` };
        }

        const id = mirrorId(path);
        if (id !== undefined && doc.MirrorMeterReading) {
            if (!this.mirrors.has(id)) return { status: 404 };
            const r = doc.MirrorMeterReading;
            this.telemetry.push({
                mirrorHref: path,
                mRID: r.mRID,
                watts: Number(r.Reading.value) * 10 ** Number(r.ReadingType?.powerOfTenMultiplier ?? 0),
                start: Number(r.Reading.timePeriod.start),
                duration: Number(r.Reading.timePeriod.duration),
                receivedAt: Date.now(),
            });
            return { status: 201 };
        }
        return { status: 404 };
    }

    private resource(path: string): string | undefined {
        const p = this.scenario.nsPrefix ?? 'csipaus';
        const ns = `xmlns="${SEP}" xmlns:${p}="${CSIPAUS}"`;
        const pollRate = this.scenario.pollRateSec ?? 60;

        const id = mirrorId(path);
        if (id !== undefined) {
            const m = this.mirrors.get(id);
            if (!m) return undefined;
            return `<MirrorUsagePoint ${ns} href="${path}">
    <mRID>${m.mRID}</mRID>
    <description>${m.description}</description>
    <roleFlags>${m.roleFlags}</roleFlags>
    <serviceCategoryKind>0</serviceCategoryKind>
    <status>1</status>
    <deviceLFDI>${m.deviceLFDI}</deviceLFDI>
    <postRate>${this.scenario.mupPostRateSec ?? 300}</postRate>
</MirrorUsagePoint>`;
        }

        switch (path) {
            case '/dcap':
                return `<DeviceCapability ${ns} href="/dcap" pollRate="${pollRate}">
    <TimeLink href="/tm"/>
    <EndDeviceListLink all="1" href="/edev"/>
    <MirrorUsagePointListLink all="${this.mirrors.size}" href="/mup"/>
</DeviceCapability>`;

            case '/tm': {
                const now = this.serverNow();
                return `<Time ${ns} href="/tm">
    <currentTime>${now}</currentTime>
    <dstEndTime>0</dstEndTime>
    <dstOffset>0</dstOffset>
    <dstStartTime>0</dstStartTime>
    <localTime>${now + 36000}</localTime>
    <quality>7</quality>
    <tzOffset>36000</tzOffset>
</Time>`;
            }

            case '/edev':
                return `<EndDeviceList ${ns} href="/edev" all="1" results="1" subscribable="0">
    <EndDevice href="/edev/1" subscribable="0">
        <FunctionSetAssignmentsListLink all="1" href="/edev/1/fsa"/>
        <lFDI>${GATEWAY_LFDI}</lFDI>
        <sFDI>167261211391</sFDI>
        <changedTime>${this.serverNow()}</changedTime>
        <enabled>true</enabled>
    </EndDevice>
</EndDeviceList>`;

            case '/edev/1/fsa':
                return `<FunctionSetAssignmentsList ${ns} href="/edev/1/fsa" all="1" results="1" subscribable="0">
    <FunctionSetAssignments href="/edev/1/fsa/1" subscribable="0">
        <DERProgramListLink all="1" href="/edev/1/fsa/1/derp"/>
        <TimeLink href="/tm"/>
        <mRID>5B58B532F06F361382ECF6F2FECDBA09</mRID>
        <description>Site gateway FSA</description>
        <version>0</version>
    </FunctionSetAssignments>
</FunctionSetAssignmentsList>`;

            case '/edev/1/fsa/1/derp':
                return `<DERProgramList ${ns} href="/edev/1/fsa/1/derp" pollRate="${pollRate}" all="1" results="1" subscribable="0">
    <DERProgram href="/derp/1" subscribable="0">
        <mRID>C882D1F83246441786FB8278FECDBA09</mRID>
        <description>Dynamic connection program</description>
        <version>0</version>
        <DefaultDERControlLink href="/derp/1/dderc"/>
        <DERControlListLink all="${this.scenario.controls.length}" href="/derp/1/derc"/>
        <primacy>1</primacy>
    </DERProgram>
</DERProgramList>`;

            case '/derp/1/dderc': {
                const d = this.scenario.defaultImportLimit;
                if (!d) return undefined; // 404: this program has no default control
                return `<DefaultDERControl ${ns} href="/derp/1/dderc" subscribable="0">
    <mRID>03E42DBAC664C4E066E77A5D00054666</mRID>
    <description>Default import limit</description>
    <version>0</version>
    <DERControlBase>
        ${activePower(p, 'opModImpLimW', d)}
    </DERControlBase>
    <setGradW>27</setGradW>
</DefaultDERControl>`;
            }

            case '/derp/1/derc': {
                const now = this.serverNow();
                // Servers drop controls once they have ended.
                const live = this.scenario.controls.filter((c) => c.start + c.duration > now);
                const items = live.map((c) => {
                    // EventStatus.currentStatus: 0 scheduled, 1 active
                    const status = c.start <= now ? 1 : 0;
                    return `    <DERControl href="/derp/1/derc/${c.mRID}" replyTo="/rsps/1/rsp" responseRequired="03">
        <mRID>${c.mRID}</mRID>
        <description>Import limit ${c.mRID}</description>
        <version>0</version>
        <creationTime>${c.start - 60}</creationTime>
        <EventStatus>
            <currentStatus>${status}</currentStatus>
            <dateTime>${now}</dateTime>
            <potentiallySuperseded>false</potentiallySuperseded>
        </EventStatus>
        <interval>
            <duration>${c.duration}</duration>
            <start>${c.start}</start>
        </interval>
        <randomizeStart>0</randomizeStart>
        <DERControlBase>
            ${activePower(p, 'opModImpLimW', c.importLimit)}
        </DERControlBase>
    </DERControl>`;
                });
                return `<DERControlList ${ns} href="/derp/1/derc" all="${live.length}" results="${live.length}" subscribable="0">
${items.join('\n')}
</DERControlList>`;
            }
        }
        return undefined;
    }
}

// Parsed XML from xml2js (see csipClient.ts).
type Xml = any;

/** N from "/mup/N", or undefined for any other path. */
function mirrorId(path: string): number | undefined {
    const m = /^\/mup\/(\d+)$/.exec(path);
    return m ? Number(m[1]) : undefined;
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => (body += chunk));
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function activePower(prefix: string, name: string, ap: ActivePower): string {
    return `<${prefix}:${name}>
            <multiplier>${ap.multiplier}</multiplier>
            <value>${ap.value}</value>
        </${prefix}:${name}>`;
}
