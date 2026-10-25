// `npm run runtime-demo` (ports 8110 HTTP, 9031 OCPP): the real program,
// `src/main.ts`, run as its own process from a config file, the way `npm
// start` and Docker run it. Checks:
//  - a bad config stops it at start-up with exit code 2 and a clear message;
//  - with a mock CSIP-AUS server (5 kW default, 3 kW control for 8 s) it caps
//    a simulated charger 5000 -> 3000 -> 5000 W;
//  - a charger that isn't in the config is refused at the handshake (HTTP
//    404) with a warning, and a configured charger's first connect isn't
//    logged as a reconnect;
//  - log lines have a timestamp, level and component;
//  - on SIGTERM it exits 0 and leaves the last cap in place. Windows can't
//    send SIGTERM, so there the same shutdown is triggered by an IPC message.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimCharger } from './chargerSim.js';
import { MockCsipServer } from './mockCsipServer.js';

const CSIP_PORT = 8110;
const OCPP_PORT = 9031;
const CONTROL_IN_S = 8;
const CONTROL_FOR_S = 8;
const WINDOWS = process.platform === 'win32';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const problems: string[] = [];
const output: string[] = [];

const dir = mkdtempSync(join(tmpdir(), 'bridge-runtime-demo-'));
const writeConfig = (name: string, cfg: unknown) => {
    const file = join(dir, name);
    writeFileSync(file, `// written by runtime-demo\n${JSON.stringify(cfg, null, 4)}\n`);
    return file;
};

// Run main.ts the same way `npm start` does (through tsx), collecting its output.
function startMain(configFile: string, extra: string[] = []): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--config', configFile, ...extra], {
        stdio: ['ignore', 'pipe', 'pipe', ...(WINDOWS ? ['ipc' as const] : [])],
    });
    for (const stream of [child.stdout!, child.stderr!]) {
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
            for (const line of chunk.split('\n').filter(Boolean)) {
                output.push(line);
                console.log(`  main | ${line}`);
            }
        });
    }
    return child;
}
const exited = (child: ChildProcess) =>
    new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) resolve(child.exitCode);
        else child.on('exit', (code) => resolve(code));
    });

// ---- 1. bad config ----
console.log('--- bad config: expect exit 2 ---');
const bad = writeConfig('bad.json', { limitSource: { type: 'csip', url: 'http://localhost:8110' }, chargers: [{ id: 'CP1', phases: 2 }] });
const badCode = await exited(startMain(bad, ['--check']));
if (badCode !== 2) problems.push(`bad config: exit code ${badCode}, expected 2`);
if (!output.some((l) => l.includes('chargers[0].phases must be one of 1, 3'))) problems.push('bad config: error message missing');

// ---- 2. the real run ----
console.log('--- real run ---');
const now = Math.floor(Date.now() / 1000);
const csip = new MockCsipServer(
    {
        defaultImportLimit: { value: 5000, multiplier: 0 },
        controls: [{ mRID: 'RUNTIME1', start: now + CONTROL_IN_S, duration: CONTROL_FOR_S, importLimit: { value: 3, multiplier: 3 } }],
    },
    () => {},
);
await csip.listen(CSIP_PORT);

const good = writeConfig('config.json', {
    limitSource: { type: 'csip', url: `http://localhost:${CSIP_PORT}` },
    ocpp: { port: OCPP_PORT },
    chargers: [{ id: 'CP1' }],
    bridge: { pollMs: 1000, commsLostAfterMs: 3000 },
    log: { level: 'info', format: 'text' },
});
const main = startMain(good);
const mainExit = exited(main);

// Connect the charger once main is listening.
const sim = new SimCharger({ id: 'CP1', endpoint: `ws://localhost:${OCPP_PORT}`, log: () => {} });
const stranger = new SimCharger({ id: 'CPX', endpoint: `ws://localhost:${OCPP_PORT}`, log: () => {} });
for (let i = 0; ; i++) {
    try {
        await sim.start();
        break;
    } catch {
        if (i > 40) throw new Error('main never started listening');
        await sleep(250);
    }
}
// A charger that isn't in the config must be refused at the handshake.
// ocpp-rpc puts the HTTP status in `code` (the message is the status text).
const strangerResult = await stranger.start().then(
    () => 'connected' as const,
    (err: Error & { code?: unknown }) => err,
);
if (strangerResult === 'connected') problems.push('unknown charger CPX was allowed to connect');
else if (strangerResult.code !== 404) problems.push(`unknown charger CPX refused, but not with 404: ${strangerResult.code} ${strangerResult.message}`);

// Watch what the charger draws.
const powers: number[] = [];
const watch = setInterval(() => {
    const w = sim.currentPowerW();
    if (powers.at(-1) !== w) powers.push(w);
}, 200);
await sleep((CONTROL_IN_S + CONTROL_FOR_S + 4) * 1000);
clearInterval(watch);
console.log(`charger power changes (W): [${powers.join(', ')}]`);
// It may draw full power for a moment before the first cap lands.
const seen = (powers[0] === 7400 ? powers.slice(1) : powers).join();
if (seen !== '5000,3000,5000') problems.push(`power changes ${powers.join()}, expected (7400,)5000,3000,5000`);

if (!output.some((l) => / WARN  .*REJECTED charger "CPX"/.test(l))) problems.push('no warning logged for refusing CPX');
if (output.some((l) => l.includes('CP1 connected') && l.includes('reconnect'))) problems.push('first connect of CP1 logged as a reconnect');
const logLine = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (DEBUG|INFO |WARN |ERROR) \[[^\]]+\] /;
const unformatted = output.filter((l) => !logLine.test(l));
if (unformatted.length > 0) problems.push(`log lines without timestamp/level/component: ${unformatted.slice(0, 3).join(' | ')}`);

// ---- 3. shutdown ----
console.log(`--- shutdown (${WINDOWS ? "IPC message: Windows can't send SIGTERM" : 'SIGTERM'}): expect exit 0 and the cap left in place ---`);
if (WINDOWS) main.send!('shutdown');
else main.kill('SIGTERM');
const code = await Promise.race([mainExit, sleep(12_000).then(() => 'timeout' as const)]);
if (code !== 0) problems.push(`after shutdown: exit ${code}, expected 0`);
if (!output.some((l) => l.includes("leaving the chargers' last caps in place"))) problems.push('no shutdown log line');
await sleep(500);
const afterW = sim.currentPowerW();
console.log(`charger draws ${afterW} W after the bridge stopped`);
if (afterW !== 5000) problems.push(`after shutdown the charger draws ${afterW} W, expected the last cap 5000 W`);

await sim.stop().catch(() => {});
await stranger.stop().catch(() => {});
await csip.close();
rmSync(dir, { recursive: true, force: true });

if (problems.length === 0) {
    console.log('RESULT: PASS - main.ts runs from config, caps the charger and shuts down cleanly');
    process.exit(0);
}
console.log(`RESULT: FAIL\n  - ${problems.join('\n  - ')}`);
process.exit(1);
