// Tab B demo: one OCPP 1.6J and one OCPP 2.0.1 charger on the same manager,
// capped through the same ManagedCharger API. Each: full power -> 3 kW -> cap
// removed. Exits non-zero on failure. Port 9020.
import { SimCharger } from './chargerSim.js';
import { Manager } from './csms.js';

const PORT = 9020;
const CAP_W = 3000;
const EV_MAX_W = 7400;
const SETTLE_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const manager = new Manager();
    await manager.listen(PORT);

    const sims = [
        new SimCharger({ id: 'CP16', protocol: '1.6', endpoint: `ws://localhost:${PORT}`, evMaxW: EV_MAX_W }),
        new SimCharger({ id: 'CP201', protocol: '2.0.1', endpoint: `ws://localhost:${PORT}`, evMaxW: EV_MAX_W }),
    ];
    const ready = Promise.all(sims.map((s) => manager.waitForCharger(s.id)));
    await Promise.all(sims.map((s) => s.start()));
    const chargers = await ready;

    // Only readings received a little after the reply are checked. Not just
    // "after the reply": a reading the charger sent just before replying can
    // be handled by ocpp-rpc a moment after the reply resolves (seen here:
    // same millisecond), so skip SETTLE_MS.
    await sleep(3000);
    const capSent = Date.now();
    await Promise.all(chargers.map((c) => c.capPower(CAP_W)));
    const capSettled = Date.now() + SETTLE_MS;
    await sleep(4000);
    const clearSent = Date.now();
    await Promise.all(chargers.map((c) => c.removeCap()));
    const clearSettled = Date.now() + SETTLE_MS;
    await sleep(3000);

    await Promise.all(sims.map((s) => s.stop()));
    await manager.close();

    let ok = true;
    for (const c of chargers) {
        const r = c.readings;
        const before = r.filter((x) => x.at < capSent).map((x) => x.watts);
        const capped = r.filter((x) => x.at >= capSettled && x.at < clearSent).map((x) => x.watts);
        const after = r.filter((x) => x.at >= clearSettled).map((x) => x.watts);
        const pass =
            before.length > 0 && before.every((w) => w === EV_MAX_W) &&
            capped.length > 0 && capped.every((w) => w === CAP_W) &&
            after.length > 0 && after.every((w) => w === EV_MAX_W);
        console.log(`\n${c.id} (OCPP ${c.version}) power (W): [${r.map((x) => x.watts).join(', ')}] ${pass ? 'ok' : 'FAIL'}`);
        if (!pass) console.log(`  cap ${capSent}/${capSettled} clear ${clearSent}/${clearSettled}: ${r.map((x) => `${x.at}:${x.watts}`).join(' ')}`);
        ok &&= pass;
    }
    ok &&= chargers[0].version === '1.6' && chargers[1].version === '2.0.1';

    console.log(ok
        ? 'RESULT: PASS - 1.6 and 2.0.1 chargers obeyed the cap and recovered'
        : 'RESULT: FAIL');
    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
