// `npm run ode-live -- --ode-dir <path>` or `npm run ode-live -- --compose`:
// the whole chain with a REAL Open Dynamic Export (ODE), not a fake one.
//
//   mock network (HTTPS) --CSIP-AUS--> ODE --MQTT--> broker --> bridge --OCPP--> sim charger
//
// Two ways to run it:
//   --ode-dir <path>  everything as processes on this machine (ports 8130-8132,
//                     9050): an in-process MQTT broker, ODE from a source
//                     checkout (pnpm install already run; v0.20.0 is what
//                     docker-compose.yml pins), and `src/main.ts`.
//   --compose         ODE, mosquitto and the bridge are already running from
//                     docker-compose.yml + ci/docker-compose.ci.yml (CI). This
//                     script only plays the network, the solar inverter and
//                     meter (over MQTT) and the charger, and checks the result.
//
// Checks: with the fake meter telling ODE the house uses 500 W, and the bridge
// reading that back from ODE's REST API, the charger gets the network's
// default (5 kW) minus the house, drops to 3 kW minus the house during a
// control the network adds while everything is running, and goes back when
// it ends; ODE registers with the mock server and posts telemetry to it.

import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { SimCharger } from './chargerSim.js';
import { lfdiOf, MockCsipServer } from './mockCsipServer.js';

const { values: args } = parseArgs({
    options: {
        'ode-dir': { type: 'string' },
        compose: { type: 'boolean', default: false },
    },
});
const odeDir = args['ode-dir'];
if (!odeDir === !args.compose) {
    console.error('usage: npm run ode-live -- --ode-dir <path to an ODE checkout>   or   --compose');
    process.exit(2);
}

const CSIP_PORT = 8130; // the mock network; ODE in Docker reaches it as host.docker.internal
const local = { mqttPort: 8131, odePort: 8132, ocppPort: 9050 };
const MQTT_URL = args.compose ? 'mqtt://localhost:1883' : `mqtt://localhost:${local.mqttPort}`;
const OCPP_URL = args.compose ? 'ws://localhost:9000' : `ws://localhost:${local.ocppPort}`;
const DEFAULT_W = 5000;
const CONTROL_W = 3000;
const CONTROL_IN_S = 10; // after the charger is first capped at the default
const CONTROL_FOR_S = 20;
const HOUSE_W = 500; // what the fake meter adds on top of the charger
// One charger, so it gets everything the house leaves.
const CHARGER_DEFAULT_W = DEFAULT_W - HOUSE_W;
const CHARGER_CONTROL_W = CONTROL_W - HOUSE_W;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const problems: string[] = [];
const children: ChildProcess[] = [];
const dir = mkdtempSync(join(tmpdir(), 'bridge-ode-live-'));

async function waitFor(what: string, timeoutMs: number, test: () => boolean): Promise<boolean> {
    for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
        if (test()) return true;
        await sleep(250);
    }
    problems.push(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    return false;
}

// ---- the network: our mock CSIP-AUS server, over HTTPS as ODE requires ----
const csip = new MockCsipServer(
    {
        defaultImportLimit: { value: DEFAULT_W, multiplier: 0 },
        controls: [],
        pollRateSec: 5, // ODE re-reads the control list this often
        mupPostRateSec: 10, // and posts telemetry this often
        // No ramping, so the limit changes as soon as ODE sees the control.
        // (With SAPN's 27, ODE ramps 0.27%/s of the inverter's 5 kW nameplate,
        // ~2.5 minutes from 5 kW to 3 kW; odeMqttSource.ts handles that.)
        setGradW: 0,
    },
    {
        tls: {
            cert: readFileSync('test-certs/mock-server.cert.pem', 'utf8'),
            key: readFileSync('test-certs/mock-server.key.pem', 'utf8'),
        },
        // Pre-register ODE's test device certificate.
        gatewayLfdi: lfdiOf(readFileSync('test-certs/ode-device.cert.pem', 'utf8')),
        log: (m) => {
            // Polls every 5 s are noise; keep registrations, posts and responses.
            if (!m.startsWith('GET ')) console.log(`[CSIP] ${m}`);
        },
    },
);
await csip.listen(CSIP_PORT);

// ---- local mode: broker, ODE and the bridge as processes ----
let broker: { aedes: Aedes; server: net.Server } | undefined;
if (odeDir) {
    const aedes = await Aedes.createBroker();
    const server = net.createServer(aedes.handle);
    await new Promise<void>((r) => server.listen(local.mqttPort, r));
    broker = { aedes, server };

    // ODE reads config.json and its certificate from CONFIG_DIR.
    const odeConfig = join(dir, 'ode');
    mkdirSync(odeConfig);
    copyFileSync('test-certs/ode-device.cert.pem', join(odeConfig, 'cert.pem'));
    copyFileSync('test-certs/ode-device.key.pem', join(odeConfig, 'key.pem'));
    writeFileSync(join(odeConfig, 'config.json'), JSON.stringify(odeConfigFor(`https://localhost:${CSIP_PORT}`, MQTT_URL), null, 4));
    startProcess('ode', process.execPath, [join(resolve(odeDir), 'node_modules/tsx/dist/cli.mjs'), 'src/app.ts'], {
        cwd: resolve(odeDir),
        // Only what ODE needs: on bad settings it logs its whole environment.
        env: {
            PATH: process.env.PATH ?? '',
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            TZ: 'Australia/Melbourne',
            SERVER_PORT: String(local.odePort),
            CONFIG_DIR: odeConfig,
            SEP2_CERT_FILE: 'cert.pem',
            SEP2_KEY_FILE: 'key.pem',
            SEP2_PEN: '62223',
        },
    });

    const bridgeConfig = join(dir, 'bridge.json');
    writeFileSync(
        bridgeConfig,
        JSON.stringify(
            {
                limitSource: { type: 'ode-mqtt', url: MQTT_URL, topic: 'limits', fallbackImportLimitW: 1500 },
                siteMeter: { type: 'ode-rest', url: `http://localhost:${local.odePort}` },
                ocpp: { port: local.ocppPort },
                chargers: [{ id: 'CP1' }],
                log: { level: 'info', format: 'text' },
            },
            null,
            4,
        ),
    );
    startProcess('bridge', process.execPath, ['--import', 'tsx', 'src/main.ts', '--config', bridgeConfig], { echo: true });
}

// ---- the site's solar inverter and meter, as ODE's MQTT inputs ----
const sim = new SimCharger({ id: 'CP1', endpoint: OCPP_URL, log: () => {} });
const devices = mqtt.connect(MQTT_URL, { reconnectPeriod: 500 });
const fakeInverter = setInterval(() => {
    if (devices.connected) devices.publish('fake/inverter', JSON.stringify(inverterSample()));
}, 1000);
// Several times a second, like a real meter, so ODE's sample is never old.
const fakeMeter = setInterval(() => {
    if (devices.connected) devices.publish('fake/meter', JSON.stringify(siteSample(sim.currentPowerW() + HOUSE_W)));
}, 200);

// ---- the charger ----
let connected = false;
for (const end = Date.now() + 60_000; !connected && Date.now() < end; ) {
    connected = await sim.start().then(
        () => true,
        () => sleep(500).then(() => false),
    );
}
if (!connected) problems.push(`the charger couldn't connect to the bridge at ${OCPP_URL}`);

const powers: { at: number; w: number }[] = [];
function recordPower() {
    const w = sim.currentPowerW();
    if (powers.at(-1)?.w !== w) {
        powers.push({ at: Date.now(), w });
        console.log(`charger now draws ${w} W`);
    }
}
const watch = setInterval(recordPower, 200);

// ODE needs a few seconds to start, register and publish.
let controlEndMs = 0;
if (connected && (await waitFor(`the charger to be capped at the ${DEFAULT_W} W default minus the house`, 120_000, () => sim.currentPowerW() === CHARGER_DEFAULT_W))) {
    // The network schedules a control while everything is running.
    const start = csip.serverNow() + CONTROL_IN_S;
    csip.setScenario({
        defaultImportLimit: { value: DEFAULT_W, multiplier: 0 },
        controls: [{ mRID: 'L1VE0DE1', start, duration: CONTROL_FOR_S, importLimit: { value: 3, multiplier: 3 } }],
        pollRateSec: 5,
        mupPostRateSec: 10,
        setGradW: 0,
    });
    const startMs = start * 1000; // the mock's clock is this machine's
    controlEndMs = startMs + CONTROL_FOR_S * 1000;
    console.log(`--- network: ${CONTROL_W} W control from ${new Date(startMs).toISOString()} for ${CONTROL_FOR_S} s ---`);

    // Halfway through, the charger must be at the control...
    await sleep(startMs + (CONTROL_FOR_S * 1000) / 2 - Date.now());
    const mid = sim.currentPowerW();
    if (mid !== CHARGER_CONTROL_W) problems.push(`halfway through the control the charger draws ${mid} W, expected ${CHARGER_CONTROL_W}`);
    // ...and back at the default soon after it ends.
    await sleep(controlEndMs - Date.now());
    await waitFor(`the charger to go back to ${CHARGER_DEFAULT_W} W after the control`, 15_000, () => sim.currentPowerW() === CHARGER_DEFAULT_W);
    // Never above the control from 5 s into it (ODE polls every 5 s) to its end.
    const over = powers.filter((p, i) => {
        const until = powers[i + 1]?.at ?? Date.now();
        return p.w > CHARGER_CONTROL_W && until > startMs + 5000 && p.at < controlEndMs;
    });
    if (over.length > 0) problems.push(`charger drew more than ${CHARGER_CONTROL_W} W during the control: ${over.map((p) => p.w).join(', ')} W`);
}

// Telemetry: ODE posts readings every mupPostRateSec.
await waitFor('ODE to post telemetry', 25_000, () => csip.telemetry.length > 0);
const mirrors = [...csip.registeredMirrors().values()].map((m) => `${m.description} (roleFlags ${m.roleFlags})`);
console.log(`ODE registered ${mirrors.length} mirror(s): ${mirrors.join(', ')}; posted ${csip.telemetry.length} reading(s)`);
// ODE posts many reading kinds (power, reactive power, voltage, ... per
// phase); the mock only reads each one's value and time period. Show one.
const r = csip.telemetry.at(-1);
if (r) {
    console.log(`  e.g. ${r.mirrorHref} value ${r.watts} for ${new Date(r.start * 1000).toISOString()} +${r.duration} s, posted ${new Date(r.receivedAt).toISOString()}`);
}
// Readings posted while their own period was still running: ODE issue #139.
const early = csip.telemetry.filter((t) => t.receivedAt < (t.start + t.duration) * 1000).length;
if (early > 0) console.log(`  ${early} of ${csip.telemetry.length} readings were posted before their period ended (ODE issue #139, not a bridge problem)`);

// ---- report and clean up ----
clearInterval(watch);
recordPower();
clearInterval(fakeInverter);
clearInterval(fakeMeter);
console.log(`charger power changes (W): [${powers.map((p) => p.w).join(', ')}]`);
await sim.stop().catch(() => {});
devices.end(true);
for (const child of children) child.kill();
await csip.close();
if (broker) {
    await new Promise<void>((r) => broker!.aedes.close(() => r()));
    broker.server.close();
}
if (odeDir) console.log(`ODE's log: ${join(dir, 'ode.log')}`);

if (problems.length > 0) {
    console.log('RESULT: FAIL');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
}
console.log('RESULT: PASS - real ODE -> bridge -> charger followed the network minus the house load: default, control, default');
process.exit(0);

// ---------------------------------------------------------------------------

function startProcess(name: string, cmd: string, argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; echo?: boolean } = {}) {
    const child = spawn(cmd, argv, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = createWriteStream(join(dir, `${name}.log`));
    for (const stream of [child.stdout!, child.stderr!]) {
        stream.pipe(log);
        if (opts.echo) {
            stream.setEncoding('utf8');
            stream.on('data', (chunk: string) => chunk.split('\n').filter(Boolean).forEach((l) => console.log(`  ${name} | ${l}`)));
        }
    }
    child.on('exit', (code, signal) => {
        if (!signal && code !== null) problems.push(`${name} exited early with code ${code} (log: ${join(dir, `${name}.log`)})`);
    });
    children.push(child);
}

// ODE's config: CSIP-AUS from the mock, inverter and meter over MQTT,
// limits published for the bridge. inverterControl off: there's no inverter.
function odeConfigFor(csipHost: string, mqttUrl: string) {
    return {
        setpoints: {
            csipAus: { host: csipHost, dcapUri: '/dcap', fixedDefault: { exportLimitWatts: 1500, importLimitWatts: 1500 } },
        },
        inverters: [{ type: 'mqtt', host: mqttUrl, topic: 'fake/inverter' }],
        inverterControl: { enabled: false },
        meter: { type: 'mqtt', host: mqttUrl, topic: 'fake/meter' },
        publish: { mqtt: { host: mqttUrl, topic: 'limits' } },
    };
}

// ODE's MQTT meter format (docs/configuration/meter.md). Positive = import.
function siteSample(importW: number) {
    return {
        realPower: { type: 'noPhase', net: importW },
        reactivePower: { type: 'noPhase', net: 0 },
        voltage: { type: 'perPhase', phaseA: 230, phaseB: null, phaseC: null },
        frequency: 50,
    };
}

// ODE's MQTT inverter format (docs/configuration/inverters.md): solar at night.
function inverterSample() {
    return {
        inverter: { realPower: 0, reactivePower: 0, voltagePhaseA: 230, voltagePhaseB: null, voltagePhaseC: null, frequency: 50 },
        nameplate: { type: 4, maxW: 5000, maxVA: 5000, maxVar: 3000 },
        settings: { maxW: 5000, maxVA: null, maxVar: null },
        status: { operationalModeStatus: 2, genConnectStatus: 7 },
    };
}
