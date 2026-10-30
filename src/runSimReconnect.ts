// `npm run sim-reconnect-demo`: the simulated charger's auto-reconnect, which
// `npm run charger-sim` turns on so the sim survives a bridge restart.
// Exits non-zero on failure. Port 9060.
//
//   AR16   OCPP 1.6,   autoReconnect on
//   AR201  OCPP 2.0.1, autoReconnect on
//   OFF    OCPP 2.0.1, autoReconnect off (what every other demo uses)
//
// 1. Cap all three at 3000 W.
// 2. The "bridge" (the OCPP server) stops for 3 s, then a new one starts on
//    the same port, as when you restart `npm start`.
// 3. AR16 and AR201 come back by themselves, still at 3000 W (a charger keeps
//    its cap; the bridge isn't there to lift it). OFF stays offline.
// 4. The new bridge caps them at 2000 W: they obey.
// 5. An intentional reconnect() on an auto-reconnect sim still works (no
//    double connection).
import { SimCharger } from './chargerSim.js';
import { Manager, SETTLE_MS, type ManagedCharger } from './csms.js';

const PORT = 9060;
const endpoint = `ws://localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ok = true;
function check(what: string, pass: boolean, detail = ''): void {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
    ok &&= pass;
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 15_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > until) {
            check(`waiting for ${what}`, false, 'timed out');
            return false;
        }
        await sleep(50);
    }
    return true;
}

const readingsSince = (c: ManagedCharger, from: number) =>
    c.readings.filter((r) => r.at >= from + SETTLE_MS).map((r) => r.watts);
const allEqual = (values: number[], expected: number) => values.length > 0 && values.every((w) => w === expected);

// Short ids in the sims' log lines, so the timeline is readable.
const sims = [
    new SimCharger({ id: 'AR16', protocol: '1.6', endpoint, autoReconnect: true }),
    new SimCharger({ id: 'AR201', endpoint, autoReconnect: true }),
    new SimCharger({ id: 'OFF', endpoint, log: () => {} }), // quiet: its failed meter sends would flood the log
];
const [ar16Sim, ar201Sim] = sims;

async function connectAll(manager: Manager, ids: string[]): Promise<ManagedCharger[]> {
    return Promise.all(ids.map((id) => manager.waitForCharger(id)));
}

async function main() {
    // 1. First bridge.
    let manager = new Manager(undefined, { bootWaitMs: 500 });
    await manager.listen(PORT);
    const first = connectAll(manager, ['AR16', 'AR201', 'OFF']);
    await Promise.all(sims.map((s) => s.start()));
    const chargers = await first;
    console.log('\n--- 1. cap all three at 3000 W ---');
    await Promise.all(chargers.map((c) => c.capPower(3000)));
    check('all three at 3000 W', sims.every((s) => s.currentPowerW() === 3000));

    // 2. Bridge restart.
    console.log('\n--- 2. bridge stops for 3 s, then a new one starts ---');
    await manager.close();
    await sleep(3000);
    check('sims keep their cap while the bridge is away', sims.every((s) => s.currentPowerW() === 3000));
    manager = new Manager(undefined, { bootWaitMs: 500 });
    await manager.listen(PORT);
    const restartedAt = Date.now();

    // 3. Auto-reconnect.
    console.log('\n--- 3. AR16 and AR201 reconnect by themselves ---');
    const [ar16, ar201] = await Promise.race([
        connectAll(manager, ['AR16', 'AR201']),
        sleep(15_000).then(() => [] as ManagedCharger[]),
    ]);
    check('both auto-reconnect sims came back', ar16 !== undefined && ar201 !== undefined);
    if (!ar16 || !ar201) return;
    console.log(`     back ${Date.now() - restartedAt} ms after the new bridge started`);
    await sleep(2500);
    for (const c of [ar16, ar201]) {
        const r = readingsSince(c, restartedAt);
        check(`${c.id} reports 3000 W to the new bridge`, allEqual(r, 3000), r.join(','));
    }
    await sleep(2000);
    check('OFF stayed offline (autoReconnect off)', manager.chargers.get('OFF')?.connected !== true);

    // 4. New bridge sends a new cap.
    console.log('\n--- 4. the new bridge caps them at 2000 W ---');
    await Promise.all([ar16.capPower(2000), ar201.capPower(2000)]);
    const cappedAt = Date.now();
    await sleep(2000);
    for (const c of [ar16, ar201]) {
        const r = readingsSince(c, cappedAt);
        check(`${c.id} at 2000 W`, allEqual(r, 2000), r.join(','));
    }

    // 5. Intentional reconnect on an auto-reconnect sim.
    console.log('\n--- 5. intentional reconnect() on AR201 ---');
    await ar201Sim.reconnect(300);
    await waitFor('AR201 connected', () => ar201.connected);
    const backAt = Date.now();
    await sleep(2000);
    const r = readingsSince(ar201, backAt);
    check('AR201 at 2000 W after reconnect()', allEqual(r, 2000), r.join(','));
    // One reading per second; two connections would roughly double it.
    check('one meter stream, not two', r.length <= 3, `${r.length} readings in ~1.7 s`);

    await Promise.all([ar16Sim.stop(), ar201Sim.stop()]);
    await manager.close();
}

const timeout = setTimeout(() => {
    console.log('FAIL: timed out');
    process.exit(1);
}, 60_000);
main()
    .catch((err) => {
        check('demo ran', false, (err as Error).stack ?? String(err));
    })
    .finally(() => {
        clearTimeout(timeout);
        console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}`);
        process.exit(ok ? 0 : 1);
    });
