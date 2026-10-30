// `npm run showcase` (ports 8140 HTTP, 9061 OCPP): the whole story in one
// terminal, for people rather than developers, in about 60 s:
//
//   the network's default limit is 5 kW -> the charger draws 5 kW
//   the network sets a 3 kW limit       -> the charger drops to 3 kW
//   the limit ends                      -> the charger goes back to 5 kW
//
// Three parts, all on this machine:
//   NETWORK  a mock CSIP-AUS server (src/mockCsipServer.ts), plain HTTP
//   BRIDGE   the real program, src/main.ts, run as its own process from a
//            config file, exactly as `npm start` runs it
//   CHARGER  one simulated OCPP 2.0.1 charger (src/chargerSim.ts)
//
// It prints friendly lines instead of raw logs (`--verbose` shows the
// bridge's own log too), draws a live power bar when run in a terminal, then
// checks what the charger actually drew and exits non-zero on failure, so CI
// runs it too.
//
// Options:
//   --verbose          also print every bridge log line
//   --live / --no-live force the live power bar on or off (default: on in a terminal)
//   --record <file>    write what was shown as JSON (used by `npm run demo-animation`)

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SimCharger } from './chargerSim.js';
import { MockCsipServer, type Scenario } from './mockCsipServer.js';
import { formatEvent, kW, MAX_W, type ShowcaseEvent, type Who } from './showcaseFormat.js';

const CSIP_PORT = 8140;
const OCPP_PORT = 9061;
const DEFAULT_W = 5000;
const CONTROL_W = 3000;
const PUBLISH_AT_S = 10; // the network publishes the control this long after the start...
const CONTROL_IN_S = 10; // ...to begin this long after that...
const CONTROL_FOR_S = 30; // ...for this long
const HOLD_AFTER_S = 8; // watch the recovery for this long before stopping
// The bridge polls every 2 s and the server clock has 1 s resolution, so
// allow this long after a change before the charger must have followed.
const FOLLOW_MS = 5000;
const WINDOWS = process.platform === 'win32';

const { values: args } = parseArgs({
    options: {
        verbose: { type: 'boolean', default: false },
        live: { type: 'boolean' },
        'no-live': { type: 'boolean', default: false },
        record: { type: 'string' },
    },
});
const live = args['no-live'] ? false : (args.live ?? process.stdout.isTTY === true);
const colour = process.stdout.isTTY === true && !process.env.NO_COLOR;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const startedAt = Date.now();
const clock = (ms = Date.now()) => new Date(ms).toTimeString().slice(0, 8); // local HH:MM:SS

// ---- screen ----
// Every printed line goes through show(), so the recording matches the screen.
// In live mode the power bar is the last line and is redrawn in place.
const shown: ShowcaseEvent[] = [];
let statusLine = '';
let lastPower: Extract<ShowcaseEvent, { kind: 'power' }> | undefined;
let lastPowerPrintAt = 0;

function show(e: ShowcaseEvent): void {
    shown.push(e);
    const text = formatEvent(e, colour);
    if (e.kind === 'power') {
        if (live) {
            statusLine = text;
            process.stdout.write(`\r\x1b[K${statusLine}`);
        } else {
            console.log(text);
        }
        return;
    }
    if (live) process.stdout.write(`\r\x1b[K${text}\n${statusLine}`);
    else console.log(text);
}
const say = (who: Who, msg: string) => show({ at: Date.now() - startedAt, kind: 'line', clock: clock(), who, msg });
const text = (t: string, style?: 'dim' | 'pass' | 'fail') => show({ at: Date.now() - startedAt, kind: 'text', text: t, style });

// ---- the network ----
const now = () => Math.floor(Date.now() / 1000);
const defaultOnly: Scenario = { defaultImportLimit: { value: DEFAULT_W, multiplier: 0 }, controls: [] };
const csip = new MockCsipServer(defaultOnly, () => {}); // its request log is too noisy for viewers
let controlStartMs = 0;
let controlEndMs = 0;
// What the network says right now, for the power bar.
const networkLimitW = () => (controlStartMs && Date.now() >= controlStartMs && Date.now() < controlEndMs ? CONTROL_W : DEFAULT_W);

// ---- the bridge: src/main.ts as its own process ----
const dir = mkdtempSync(join(tmpdir(), 'bridge-showcase-'));
const configFile = join(dir, 'config.json');
writeFileSync(
    configFile,
    JSON.stringify(
        {
            limitSource: { type: 'csip', url: `http://localhost:${CSIP_PORT}` },
            ocpp: { port: OCPP_PORT },
            chargers: [{ id: 'CP1' }],
            bridge: { pollMs: 2000, commsLostAfterMs: 6000 },
            log: { level: 'info', format: 'json' }, // JSON so we can read it reliably
        },
        null,
        4,
    ),
);

const bridgeLog: string[] = [];
const capsSent: number[] = [];
let main: ChildProcess | undefined;

// Turn the bridge's log into lines a viewer can follow. Lines we don't
// translate are only shown with --verbose; warnings and errors always are.
function onBridgeLog(raw: string): void {
    bridgeLog.push(raw);
    let entry: { level: string; component: string; msg: string };
    try {
        entry = JSON.parse(raw);
    } catch {
        if (args.verbose) text(`          bridge | ${raw}`, 'dim');
        return;
    }
    if (args.verbose) text(`          bridge | [${entry.component}] ${entry.msg}`, 'dim');
    const cap = /^site limit (\d+) W \((default|control [^)]*)\) -> (\d+) W each for (.+)$/.exec(entry.msg);
    if (entry.component === 'bridge' && cap) {
        const [, siteW, why, shareW, ids] = cap;
        capsSent.push(Number(shareW));
        const kind = why === 'default' ? 'default limit' : 'network control';
        say('BRIDGE', `site limit ${kW(Number(siteW))} (${kind}) -> capping ${ids} to ${shareW} W over OCPP`);
    } else if (entry.component === 'ocpp' && / connected /.test(entry.msg)) {
        say('BRIDGE', entry.msg.replace(/ connected \(OCPP (.+)\)$/, ' connected to the bridge (OCPP $1)'));
    } else if (entry.level === 'warn' || entry.level === 'error') {
        say('BRIDGE', `${entry.level.toUpperCase()}: ${entry.msg}`);
    }
}

function startMain(): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--config', configFile], {
        stdio: ['ignore', 'pipe', 'pipe', ...(WINDOWS ? ['ipc' as const] : [])],
    });
    for (const stream of [child.stdout!, child.stderr!]) {
        stream.setEncoding('utf8');
        let partial = '';
        stream.on('data', (chunk: string) => {
            const lines = (partial + chunk).split('\n');
            partial = lines.pop()!;
            for (const line of lines.map((l) => l.trim()).filter(Boolean)) onBridgeLog(line);
        });
    }
    return child;
}

// ---- the charger ----
const sim = new SimCharger({
    id: 'CP1',
    endpoint: `ws://localhost:${OCPP_PORT}`,
    evMaxW: MAX_W,
    log: (m) => {
        const set = /^SetChargingProfile id=\d+ (\d+) (W|A) -> now drawing (\d+) W$/.exec(m);
        if (set) say('CHARGER', `CP1 got a ${set[1]} ${set[2]} cap -> drawing ${set[3]} W`);
        else if (/^Transaction .* started$/.test(m)) say('CHARGER', `CP1: car plugged in, charging at full power (${MAX_W} W)`);
    },
});

// ---- checking ----
const samples: { at: number; watts: number }[] = [];
const problems: string[] = [];

function check(): void {
    const changes = samples.map((s) => s.watts).filter((w, i, all) => i === 0 || w !== all[i - 1]);
    // It may draw full power for a moment before the first cap lands.
    const seen = (changes[0] === MAX_W ? changes.slice(1) : changes).join(' -> ');
    const want = [DEFAULT_W, CONTROL_W, DEFAULT_W].join(' -> ');
    if (seen !== want) problems.push(`the charger's power went ${changes.join(' -> ')} W, expected (${MAX_W} -> )${want} W`);
    const during = samples.filter((s) => s.at >= controlStartMs + FOLLOW_MS && s.at < controlEndMs);
    const over = during.filter((s) => s.watts > CONTROL_W);
    if (during.length === 0) problems.push('no readings during the control');
    else if (over.length > 0) problems.push(`drew more than ${CONTROL_W} W during the control (${over[0].watts} W at ${clock(over[0].at)})`);
    const after = samples.filter((s) => s.at >= controlEndMs + FOLLOW_MS);
    if (after.length === 0 || after.some((s) => s.watts !== DEFAULT_W)) problems.push(`not back at ${DEFAULT_W} W after the control ended`);
    const before = samples.filter((s) => s.at >= startedAt + FOLLOW_MS && s.at < controlStartMs);
    if (before.some((s) => s.watts > DEFAULT_W)) problems.push(`drew more than the ${DEFAULT_W} W default before the control`);
    if (!capsSent.includes(CONTROL_W)) problems.push(`no "capping CP1 to ${CONTROL_W} W" line from the bridge (did its log format change?)`);
}

async function run(): Promise<void> {
    text('csip-ocpp-bridge showcase: a mock network, the real bridge (src/main.ts) and one simulated charger.');
    text(`All on this machine, about ${PUBLISH_AT_S + CONTROL_IN_S + CONTROL_FOR_S + HOLD_AFTER_S} s. Ctrl+C stops it.`, 'dim');
    text('');

    await csip.listen(CSIP_PORT);
    say('NETWORK', `default limit for this site: ${kW(DEFAULT_W)} (CSIP-AUS DefaultDERControl)`);

    main = startMain();
    const mainExit = new Promise<number | null>((resolve) => main!.on('exit', (code) => resolve(code)));
    for (let i = 0; ; i++) {
        try {
            await sim.start();
            break;
        } catch {
            if (i > 80) throw new Error("the bridge never started listening for chargers");
            await sleep(250);
        }
    }

    const watch = setInterval(() => {
        const watts = sim.currentPowerW();
        samples.push({ at: Date.now(), watts });
        const e = { at: Date.now() - startedAt, kind: 'power' as const, chargerId: 'CP1', watts, limitW: networkLimitW() };
        // Live: redraw when something changes. Otherwise: a line on change and every 5 s.
        const changed = e.watts !== lastPower?.watts || e.limitW !== lastPower?.limitW;
        if (changed || (!live && Date.now() - lastPowerPrintAt >= 5000)) {
            show(e);
            lastPower = e;
            lastPowerPrintAt = Date.now();
        }
    }, 250);

    await sleep(startedAt + PUBLISH_AT_S * 1000 - Date.now());
    const startSec = now() + CONTROL_IN_S;
    csip.setScenario({
        ...defaultOnly,
        controls: [{ mRID: 'PEAK0001', start: startSec, duration: CONTROL_FOR_S, importLimit: { value: CONTROL_W / 1000, multiplier: 3 } }],
    });
    controlStartMs = startSec * 1000;
    controlEndMs = controlStartMs + CONTROL_FOR_S * 1000;
    say('NETWORK', `new control: limit this site to ${kW(CONTROL_W)} from ${clock(controlStartMs)} for ${CONTROL_FOR_S} s`);

    await sleep(controlStartMs - Date.now());
    say('NETWORK', `control started: ${kW(CONTROL_W)} limit now`);
    await sleep(controlEndMs - Date.now());
    say('NETWORK', `control ended: back to the ${kW(DEFAULT_W)} default`);
    await sleep(HOLD_AFTER_S * 1000);
    clearInterval(watch);

    // Stop the bridge the way a person would (Ctrl+C / docker stop).
    if (WINDOWS) main.send!('shutdown');
    else main.kill('SIGTERM');
    const code = await Promise.race([mainExit, sleep(12_000).then(() => 'timeout' as const)]);
    if (code !== 0) problems.push(`the bridge exited with ${code} on shutdown, expected 0`);
    await sim.stop().catch(() => {});
    check();
}

let finished = false;
async function finish(ok: boolean): Promise<never> {
    if (finished) process.exit(1);
    finished = true;
    if (live) process.stdout.write('\n'); // keep the last power bar where it is
    statusLine = ''; // and stop redrawing it under each new line
    shown.push({ at: Date.now() - startedAt, kind: 'barDone' });
    text('');
    if (ok) {
        text(`RESULT: PASS - the charger followed the network: ${DEFAULT_W} -> ${CONTROL_W} -> ${DEFAULT_W} W`, 'pass');
    } else {
        text('RESULT: FAIL', 'fail');
        for (const p of problems) text(`  - ${p}`, 'fail');
        if (!args.verbose) {
            text('  last bridge log lines:', 'dim');
            for (const l of bridgeLog.slice(-10)) text(`    ${l}`, 'dim');
        }
    }
    if (args.record) writeFileSync(args.record, JSON.stringify({ startedAt, events: shown }, null, 1));
    main?.kill();
    void csip.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
}

process.on('SIGINT', () => {
    problems.push('stopped with Ctrl+C');
    void finish(false);
});
const timeout = setTimeout(() => {
    problems.push('timed out');
    void finish(false);
}, (PUBLISH_AT_S + CONTROL_IN_S + CONTROL_FOR_S + HOLD_AFTER_S + 40) * 1000);

run()
    .then(() => finish(problems.length === 0))
    .catch((err) => {
        problems.push((err as Error).message);
        return finish(false);
    })
    .finally(() => clearTimeout(timeout));
