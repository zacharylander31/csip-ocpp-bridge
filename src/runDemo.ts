// Week 3 demo: full power -> capped at 3 kW -> cap removed. Exits non-zero on failure.
import { SimCharger } from './chargerSim.js';
import { Manager, SETTLE_MS } from './csms.js';

const PORT = 9000;
const CAP_W = 3000;
const EV_MAX_W = 7400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const manager = new Manager();
    await manager.listen(PORT);

    const sim = new SimCharger({
        id: 'CP1',
        endpoint: `ws://localhost:${PORT}`,
        evMaxW: EV_MAX_W,
        meterIntervalMs: 1000,
    });
    const chargerReady = manager.waitForCharger('CP1');
    await sim.start();
    const charger = await chargerReady;

    // A reading can already be in flight when we send a command, so only
    // readings received SETTLE_MS after the reply are checked (one in flight
    // can still be handled just after the reply resolves; see csms.ts).
    // Readings between send and reply + SETTLE_MS are ambiguous and not checked.
    await sleep(4000);
    const capSent = Date.now();
    await charger.capPower(CAP_W);
    const capAcked = Date.now();
    await sleep(6000);
    const clearSent = Date.now();
    await charger.removeCap();
    const clearAcked = Date.now();
    await sleep(5000);

    await sim.stop();
    await manager.close();

    const r = charger.readings;
    const before = r.filter((x) => x.at < capSent).map((x) => x.watts);
    const capped = r.filter((x) => x.at >= capAcked + SETTLE_MS && x.at < clearSent).map((x) => x.watts);
    const after = r.filter((x) => x.at >= clearAcked + SETTLE_MS).map((x) => x.watts);

    console.log(`\nPower drawn each second (W): [${r.map((x) => x.watts).join(', ')}]`);

    const ok =
        before.length > 0 && before.every((w) => w === EV_MAX_W) &&
        capped.length > 0 && capped.every((w) => w <= CAP_W) &&
        after.length > 0 && after.every((w) => w === EV_MAX_W);

    console.log(ok
        ? 'RESULT: PASS - charger obeyed the cap and recovered'
        : `RESULT: FAIL - before=${before} capped=${capped} after=${after}`);
    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
