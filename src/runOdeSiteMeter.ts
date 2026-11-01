// `npm run site-meter-demo` (ports 8150 MQTT, 8151 ODE's REST API, 9070 OCPP):
// the real program, `src/main.ts`, with a site meter. No real ODE here: a fake
// one with an in-process MQTT broker for its limits and an HTTP server for
// its status API, so everything crosses the same protocols as on a real site.
// (`npm run ode-live` does a shorter version of this with the real ODE.)
//
// Two chargers (cars want 7.4 kW each, reporting power every 5 s, as main.ts
// asks them to). Each charger gets (limit - house) / 2:
//   ODE has no sample yet        limit 5000, house ?      -> 0 W each
//   meter starts                 limit 5000, house  1000  -> 2000 each
//   kettle on                    limit 5000, house  3000  -> 1000 each
//   kettle off                   limit 5000, house  1000  -> 2000 each
//   3 kW control                 limit 3000, house  1000  -> 1000 each
//   solar exporting              limit 3000, house -1500  -> 2200 each
//   meter dies (date stops)      house unknown            -> 0 W each
//   meter back                                            -> 2200 each
//   ODE's API down (HTTP fails)  house unknown            -> 0 W each
//   ODE's API back                                        -> 2200 each
//   control ends                 limit 5000, house -1500  -> 3200 each
//   CP2 goes offline             its draw looks like house -> CP1 1600
// Checks each step, how fast the meter's silence is noticed, and that the site
// is only over the limit for a moment after something changes.
// Exits non-zero on failure.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Aedes } from 'aedes';
import { SimCharger } from './chargerSim.js';
import { parseOdeStatus } from './odeSiteMeter.js';

const MQTT_PORT = 8150;
const ODE_PORT = 8151;
const OCPP_PORT = 9070;
const TOPIC = 'limits';
const SILENT_AFTER_MS = 6000;
// Waiting for a change to show on the chargers: the meter's reading (1 s poll
// + our 1 s margin), up to 5 s for a charger's next report, a tick, a reply.
const STEP_TIMEOUT_MS = 15_000;
const HOLD_MS = 2000; // a share must stay put this long to count
// How long the site may be over the limit after the house load or limit rises.
const REACTION_ALLOWANCE_MS = 8000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const problems: string[] = [];
const output: string[] = [];

// ---- parsing ODE's status: everything that must never become a reading ----
function refused(text: string, why: string): void {
    try {
        parseOdeStatus(text);
        problems.push(`accepted a bad status response: ${why}`);
    } catch {
        // right
    }
}
const goodStatus = { running: true, siteSample: { date: '2026-11-02T01:00:00.000Z', realPower: { type: 'noPhase', net: -1500.5 } } };
const parsed = parseOdeStatus(JSON.stringify(goodStatus));
if (parsed.watts !== -1500.5 || parsed.dateMs !== Date.UTC(2026, 10, 2, 1)) problems.push(`parsed the status wrongly: ${JSON.stringify(parsed)}`);
const statusWith = (realPower: unknown, date: unknown = goodStatus.siteSample.date) => JSON.stringify({ running: true, siteSample: { date, realPower } });
refused('<html>', 'not JSON');
refused('[]', 'not an object');
refused('{"running":false}', 'coordinator stopped');
refused('{"running":true,"siteSample":null}', 'no sample yet');
refused(statusWith({ net: '1000' }), 'net is a string');
refused(statusWith({ net: null }), 'net is null');
refused(statusWith({}), 'net is missing');
refused(statusWith(1000), 'realPower is not an object');
refused(statusWith({ net: 1000 }, 'yesterday'), 'bad date');

// ---- the fake ODE ----
const aedes = await Aedes.createBroker();
const mqttServer = net.createServer(aedes.handle);
await new Promise<void>((r) => mqttServer.listen(MQTT_PORT, r));

const sims = ['CP1', 'CP2'].map((id) => new SimCharger({ id, endpoint: `ws://localhost:${OCPP_PORT}`, log: () => {} }));
let houseW = 1000;
const siteW = () => houseW + sims.reduce((sum, s) => sum + s.currentPowerW(), 0);

// What ODE's status API returns. 'no-sample': ODE hasn't read its meter yet.
// 'frozen': its meter died, so it keeps returning the last sample and date.
let meter: 'no-sample' | 'live' | 'frozen' | 'http-500' = 'no-sample';
let frozenStatus = '';
const statusNow = () =>
    JSON.stringify({
        running: true,
        invertersDataCache: null,
        derSample: null,
        siteSample: {
            date: new Date().toISOString(),
            realPower: { type: 'noPhase', net: siteW() }, // ODE's sign: + import, - export
            reactivePower: { type: 'noPhase', net: 0 },
            voltage: { type: 'perPhase', phaseA: 230, phaseB: null, phaseC: null },
            frequency: 50,
        },
        loadWatts: null,
        controlLimits: null,
        inverterConfiguration: null,
    });
const odeApi = http.createServer((req, res) => {
    if (req.url !== '/api/coordinator/status') return void res.writeHead(404).end();
    if (meter === 'http-500') return void res.writeHead(500).end('{"message":"boom"}');
    const body =
        meter === 'no-sample' ? JSON.stringify({ running: true, siteSample: null }) : meter === 'frozen' ? frozenStatus : statusNow();
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
});
await new Promise<void>((r) => odeApi.listen(ODE_PORT, r));

// ODE's limit, about once a second (format: plans/notes/tab-a.md).
let limitW = 5000;
let control: { start: string; end: string } | undefined;
const publishLimit = () => {
    const payload = JSON.stringify({
        limit: { source: 'csipAus', opModImpLimW: limitW },
        setGradW: 0,
        schedules: {
            opModImpLimW: control
                ? [{ mRID: 'EVENING', effectiveStartInclusive: control.start, effectiveEndExclusive: control.end }]
                : [],
        },
    });
    aedes.publish({ cmd: 'publish', topic: `${TOPIC}/csipAus`, payload: Buffer.from(payload), qos: 0, retain: false, dup: false }, () => {});
};
const limitTimer = setInterval(publishLimit, 1000);

// ---- the real program ----
const dir = mkdtempSync(join(tmpdir(), 'bridge-site-meter-'));
const configFile = join(dir, 'config.json');
writeFileSync(
    configFile,
    JSON.stringify({
        limitSource: { type: 'ode-mqtt', url: `mqtt://localhost:${MQTT_PORT}`, topic: TOPIC, fallbackImportLimitW: 1500 },
        siteMeter: { type: 'ode-rest', url: `http://localhost:${ODE_PORT}`, silentAfterMs: SILENT_AFTER_MS },
        ocpp: { port: OCPP_PORT },
        // This demo's 1000 W shares are below a real car's 6 A (1380 W).
        chargerDefaults: { minAmpsPerPhase: 0 },
        chargers: [{ id: 'CP1' }, { id: 'CP2' }],
    }),
);
const main = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [main.stdout!, main.stderr!]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
        for (const line of chunk.split('\n').filter(Boolean)) {
            output.push(line);
            console.log(`  main | ${line}`);
        }
    });
}
let exited = false;
main.on('exit', (code) => {
    exited = true;
    problems.push(`main.ts exited early with code ${code}`);
});

let connected = false;
for (const end = Date.now() + 30_000; !connected && Date.now() < end; ) {
    connected = await Promise.all(sims.map((s) => s.start())).then(
        () => true,
        () => sleep(300).then(() => false),
    );
}
if (!connected) problems.push("the chargers couldn't connect to main.ts");

// ---- checking ----
// Sample the true site power all the time; the limit may only be broken just
// after something that raises the load or lowers the limit.
let lastEventAt = Date.now();
const event = (what: string) => {
    console.log(`--- ${what} ---`);
    lastEventAt = Date.now();
};
let capped = false; // before the first cap the chargers are unrestricted
const over: string[] = [];
const watcher = setInterval(() => {
    const site = siteW();
    if (capped && site > limitW && Date.now() - lastEventAt > REACTION_ALLOWANCE_MS) {
        over.push(`${site} W with limit ${limitW} W, ${Math.round((Date.now() - lastEventAt) / 1000)} s after the last change`);
    }
}, 250);

// Wait for the chargers to be on `watts`, and to stay there. Returns how long it took.
async function expectShare(watts: number, what: string, chargers = sims): Promise<number> {
    const startedAt = Date.now();
    let heldSince: number | undefined;
    while (Date.now() - startedAt < STEP_TIMEOUT_MS + HOLD_MS) {
        const ok = chargers.every((s) => s.currentPowerW() === watts);
        if (!ok) heldSince = undefined;
        else if (heldSince === undefined) heldSince = Date.now();
        else if (Date.now() - heldSince >= HOLD_MS) {
            console.log(`OK: ${what}: ${watts} W each after ${((heldSince - startedAt) / 1000).toFixed(1)} s, site ${siteW()} W, limit ${limitW} W`);
            return heldSince - startedAt;
        }
        await sleep(100);
    }
    problems.push(`${what}: expected ${watts} W each, chargers draw ${chargers.map((s) => s.currentPowerW()).join(', ')} W`);
    return Infinity;
}

// ---- the timeline ----
if (connected) {
    event('ODE is up but has no meter sample: house load unknown');
    await expectShare(0, 'no meter sample');
    capped = true;

    event('meter starts: house 1000 W');
    meter = 'live';
    await expectShare(2000, 'house 1000 W, limit 5000 W');

    event('kettle on: house 3000 W');
    houseW = 3000;
    await expectShare(1000, 'kettle on');

    event('kettle off: house 1000 W');
    houseW = 1000;
    await expectShare(2000, 'kettle off');

    event('network control: limit 3000 W');
    control = { start: new Date(Date.now() - 1000).toISOString(), end: new Date(Date.now() + 3_600_000).toISOString() };
    limitW = 3000;
    await expectShare(1000, '3 kW control');

    event('solar exporting: house -1500 W (site meter reads negative once the chargers are counted out)');
    houseW = -1500;
    await expectShare(2200, 'solar exporting');

    event('site meter dies: ODE keeps returning its last sample');
    frozenStatus = statusNow();
    meter = 'frozen';
    const tookFrozen = await expectShare(0, 'meter silent');
    if (tookFrozen < SILENT_AFTER_MS - 2000) problems.push(`chargers went to 0 W ${tookFrozen} ms after the meter froze, before silentAfterMs`);
    if (tookFrozen > SILENT_AFTER_MS + 2000) problems.push(`chargers took ${tookFrozen} ms to go to 0 W, silentAfterMs is ${SILENT_AFTER_MS}`);
    if (!output.some((l) => l.includes('WARN') && l.includes('SITE METER SILENT'))) problems.push('no SITE METER SILENT warning');

    event('site meter back');
    meter = 'live';
    await expectShare(2200, 'meter back');
    if (!output.some((l) => l.includes('site meter back'))) problems.push('no "site meter back" line');

    event("ODE's API fails: HTTP 500");
    meter = 'http-500';
    await expectShare(0, 'ODE API down');
    if (!output.some((l) => l.includes('WARN') && l.includes("couldn't read the site meter") && l.includes('HTTP 500'))) {
        problems.push("no warning about not reading the site meter");
    }

    event("ODE's API back");
    meter = 'live';
    await expectShare(2200, 'ODE API back');

    event('control ends: limit 5000 W');
    control = undefined;
    limitW = 5000;
    await expectShare(3200, 'control ended');

    // CP2 drops off the network but keeps drawing its last cap. Its draw now
    // looks like house load (-1500 + 3200 = 1700 W), which is the safe way
    // round: CP1 gets (5000 - 1700) / 2 = 1650, rounded down to 1600 W.
    event('CP2 goes offline, still drawing 3200 W');
    await sims[1].stop();
    await expectShare(1600, 'CP2 offline, CP1', [sims[0]]);
}

// ---- report and clean up ----
clearInterval(watcher);
clearInterval(limitTimer);
const reports = output.filter((l) => l.includes('reports power every 5 s')).length;
if (reports < 2) problems.push(`expected both chargers to accept 5 s power reports, saw ${reports}`);
for (const o of over) problems.push(`site over the limit: ${o}`);
main.removeAllListeners('exit');
if (!exited) main.kill();
await Promise.all(sims.map((s) => s.stop().catch(() => {})));
await new Promise<void>((r) => aedes.close(() => r()));
mqttServer.close();
odeApi.closeAllConnections();
odeApi.close();

if (problems.length > 0) {
    console.log('RESULT: FAIL');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
}
console.log('RESULT: PASS - chargers got limit minus house load from ODE\'s meter, and 0 W when it went silent');
process.exit(0);
