// `npm run sp1-demo` (ports 8120 HTTP, 9040 OCPP): OCPP Security Profile 1
// (charger passwords) in the real program, `src/main.ts`, run as its own
// process from a config file with the password in an environment variable,
// the way Docker runs it. Checks:
//  - a password that's too short stops it at start-up (exit 2), and the error
//    doesn't repeat the password;
//  - CP1 (passwordEnv set) with no password: refused, HTTP 401;
//  - CP1 with the wrong password (shorter, and same length): refused, 401,
//    logged once a minute, not on every try;
//  - CPX (not configured) with CP1's password: still refused with 404;
//  - CP1 with the right password: connects and gets its share (2500 W of a
//    5 kW default split with CP2);
//  - CP2 (no passwordEnv) connects without one, and start-up warns about it;
//  - no password, right or wrong (or its base64), ever appears in the output.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimCharger } from './chargerSim.js';
import { MockCsipServer } from './mockCsipServer.js';

const CSIP_PORT = 8120;
const OCPP_PORT = 9040;
const PASSWORD_ENV = 'SP1_DEMO_CP1_PASSWORD';
// Made up for this demo; a real one comes from a random generator (docs/install.md).
const RIGHT = 'demo-Pw_7fK2xQ9mL4vR';
const WRONG_SAME_LENGTH = 'demo-Pw_7fK2xQ9mL4vS';
const WRONG_SHORT = 'nope';
const TOO_SHORT = 'tooShort123';
const WINDOWS = process.platform === 'win32';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const problems: string[] = [];
const output: string[] = [];

const dir = mkdtempSync(join(tmpdir(), 'bridge-sp1-demo-'));
const writeConfig = (name: string, cfg: unknown) => {
    const file = join(dir, name);
    writeFileSync(file, `// written by sp1-demo\n${JSON.stringify(cfg, null, 4)}\n`);
    return file;
};

function startMain(configFile: string, password: string, extra: string[] = []): ChildProcess {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--config', configFile, ...extra], {
        stdio: ['ignore', 'pipe', 'pipe', ...(WINDOWS ? ['ipc' as const] : [])],
        env: { ...process.env, [PASSWORD_ENV]: password },
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

const config = writeConfig('config.json', {
    limitSource: { type: 'csip', url: `http://localhost:${CSIP_PORT}` },
    ocpp: { port: OCPP_PORT },
    chargers: [{ id: 'CP1', passwordEnv: PASSWORD_ENV }, { id: 'CP2' }],
    bridge: { pollMs: 1000, commsLostAfterMs: 3000 },
    log: { level: 'info', format: 'text' },
});

// ---- 1. a bad password stops it at start-up ----
console.log('--- password too short: expect exit 2 ---');
const badCode = await exited(startMain(config, TOO_SHORT, ['--check']));
if (badCode !== 2) problems.push(`too-short password: exit code ${badCode}, expected 2`);
if (!output.some((l) => l.includes(`the password in ${PASSWORD_ENV} is ${TOO_SHORT.length} characters`))) {
    problems.push('too-short password: error message missing');
}

// ---- 2. the real run ----
console.log('--- real run ---');
const csip = new MockCsipServer({ defaultImportLimit: { value: 5000, multiplier: 0 }, controls: [] }, () => {});
await csip.listen(CSIP_PORT);
const main = startMain(config, RIGHT);
const mainExit = exited(main);

const endpoint = `ws://localhost:${OCPP_PORT}`;
const sim = (id: string, password?: string) => new SimCharger({ id, endpoint, password, log: () => {} });
// Resolves to 'connected' or the HTTP status the bridge refused it with.
const tryConnect = (charger: SimCharger) =>
    charger.start().then(
        () => 'connected' as const,
        (err: Error & { code?: unknown }) => err.code,
    );

// CP2 has no password: wait for main to listen by connecting it.
const cp2 = sim('CP2');
for (let i = 0; ; i++) {
    if ((await tryConnect(cp2)) === 'connected') break;
    if (i > 40) throw new Error('main never started listening');
    await sleep(250);
}

const attempts: [string, SimCharger, unknown][] = [
    ['CP1 without a password', sim('CP1'), 401],
    ['CP1 with a short wrong password', sim('CP1', WRONG_SHORT), 401],
    ['CP1 with a same-length wrong password', sim('CP1', WRONG_SAME_LENGTH), 401],
    ['CP1 with a same-length wrong password, again', sim('CP1', WRONG_SAME_LENGTH), 401],
    ['CPX (not configured) with the right password', sim('CPX', RIGHT), 404],
];
for (const [what, charger, expected] of attempts) {
    const result = await tryConnect(charger);
    console.log(`${what}: ${result}`);
    if (result !== expected) problems.push(`${what}: got ${String(result)}, expected ${expected}`);
}

const cp1 = sim('CP1', RIGHT);
const cp1Result = await tryConnect(cp1);
console.log(`CP1 with the right password: ${cp1Result}`);
if (cp1Result !== 'connected') problems.push(`CP1 with the right password: got ${String(cp1Result)}, expected to connect`);

// Both chargers should end up with half the 5 kW default.
for (let i = 0; i < 40 && (cp1.currentPowerW() !== 2500 || cp2.currentPowerW() !== 2500); i++) await sleep(250);
console.log(`CP1 draws ${cp1.currentPowerW()} W, CP2 draws ${cp2.currentPowerW()} W`);
if (cp1.currentPowerW() !== 2500 || cp2.currentPowerW() !== 2500) {
    problems.push(`chargers draw ${cp1.currentPowerW()} / ${cp2.currentPowerW()} W, expected 2500 / 2500`);
}

// ---- 3. logs ----
const count = (re: RegExp) => output.filter((l) => re.test(l)).length;
if (count(/ WARN  .*REJECTED charger "CP1".*: no password \(HTTP 401\)/) !== 1) problems.push('expected one warning for CP1 without a password');
// Two wrong-password tries within a minute: logged once.
if (count(/ WARN  .*REJECTED charger "CP1".*: wrong password \(HTTP 401\)/) !== 1) {
    problems.push(`expected exactly one wrong-password warning (rate-limited), got ${count(/wrong password/)}`);
}
if (count(/ WARN  .*REJECTED charger "CPX".*not a configured charger/) !== 1) problems.push('expected one warning for CPX');
if (!output.some((l) => / WARN  .*CP2 have no passwordEnv/.test(l))) problems.push('no start-up warning about CP2 having no password');
if (!output.some((l) => l.includes(`CP1 (`) && l.includes(`password from ${PASSWORD_ENV}`))) problems.push('start-up line does not say where CP1\'s password comes from');
const secrets = [RIGHT, WRONG_SAME_LENGTH, WRONG_SHORT, TOO_SHORT].flatMap((pw) => [pw, Buffer.from(`CP1:${pw}`).toString('base64')]);
const leaks = output.filter((l) => secrets.some((s) => l.includes(s)));
if (leaks.length > 0) problems.push(`password in the logs: ${leaks.join(' | ')}`);

// ---- 4. shutdown ----
if (WINDOWS) main.send!('shutdown');
else main.kill('SIGTERM');
const code = await Promise.race([mainExit, sleep(12_000).then(() => 'timeout' as const)]);
if (code !== 0) problems.push(`after shutdown: exit ${code}, expected 0`);

for (const charger of [cp1, cp2]) await charger.stop().catch(() => {});
await csip.close();
rmSync(dir, { recursive: true, force: true });

if (problems.length === 0) {
    console.log('RESULT: PASS - only a charger with the right password connects; no password in the logs');
    process.exit(0);
}
console.log(`RESULT: FAIL\n  - ${problems.join('\n  - ')}`);
process.exit(1);
