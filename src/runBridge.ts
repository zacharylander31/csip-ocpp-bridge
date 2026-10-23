// Week 5 demo: CSIP-AUS limit -> bridge -> two OCPP chargers, end to end.
// Network default 5 kW -> 3 kW control for 8 s -> back to the 5 kW default.
// Both cars want 7.4 kW, so each charger should draw 2500, then 1500, then
// 2500 (half the site limit each). Exits non-zero on failure.
import { Bridge } from './bridge.js';
import { SimCharger } from './chargerSim.js';
import { CsipClient } from './csipClient.js';
import { Manager, SETTLE_MS } from './csms.js';
import { MockCsipServer } from './mockCsipServer.js';

// Different ports from `npm run demo` / `npm run mock-csip`, so they can run alongside.
const CSIP_PORT = 8082;
const OCPP_PORT = 9001;
const EV_MAX_W = 7400;
const CHARGER_IDS = ['CP1', 'CP2'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const csip = new MockCsipServer({ controls: [] }, () => {}); // quiet
    await csip.listen(CSIP_PORT);
    const now = csip.serverNow();
    csip.setScenario({
        defaultImportLimit: { value: 5000, multiplier: 0 },
        controls: [{ mRID: 'EVENING-PEAK', start: now + 6, duration: 8, importLimit: { value: 3, multiplier: 3 } }],
    });

    const manager = new Manager();
    await manager.listen(OCPP_PORT);
    const sims = CHARGER_IDS.map(
        (id) => new SimCharger({ id, endpoint: `ws://localhost:${OCPP_PORT}`, evMaxW: EV_MAX_W }),
    );
    const chargersReady = Promise.all(CHARGER_IDS.map((id) => manager.waitForCharger(id)));
    await Promise.all(sims.map((s) => s.start()));
    const chargers = await chargersReady;

    // Poll every 5 s and check every 0.5 s. The control's start and end land
    // between polls, so this also shows the bridge doesn't wait for a poll.
    const bridge = new Bridge(new CsipClient(`http://localhost:${CSIP_PORT}`), chargers, {
        pollMs: 5000,
        tickMs: 500,
    });
    await bridge.start();
    await sleep(20_000);

    await bridge.stop();
    await Promise.all(sims.map((s) => s.stop()));
    await manager.close();
    await csip.close();

    // Check each charger: after each change was acked, and until the next
    // change to that charger was sent, every reading must equal what the car
    // can draw under its share. Readings between send and ack are ambiguous
    // (one may be in flight) and skipped.
    console.log();
    const problems: string[] = [];
    for (const charger of chargers) {
        const r = charger.readings;
        const changes = bridge.changes.filter((c) => c.chargerId === charger.id);
        console.log(`${charger.id} power each second (W): [${r.map((x) => x.watts).join(', ')}]`);
        console.log(`${charger.id} shares applied (W):    [${changes.map((c) => `${c.limitW} of ${c.siteLimitW} ${c.source}`).join(', ')}]`);

        const shares = changes.map((c) => c.limitW);
        if (shares.join() !== '2500,1500,2500') {
            problems.push(`${charger.id}: expected shares 2500,1500,2500, got ${shares.join()}`);
        }
        changes.forEach((c, i) => {
            const until = changes[i + 1]?.sentAt ?? Infinity;
            const want = Math.min(EV_MAX_W, c.limitW ?? EV_MAX_W);
            const got = r.filter((x) => x.at >= c.ackedAt + SETTLE_MS && x.at < until).map((x) => x.watts);
            if (got.length === 0) problems.push(`${charger.id}: no readings under share ${c.limitW}`);
            if (got.some((w) => w !== want)) problems.push(`${charger.id}: under share ${c.limitW} wanted ${want}, got [${got}]`);
        });
    }

    console.log(problems.length === 0
        ? 'RESULT: PASS - site limit split across both chargers, and they recovered'
        : `RESULT: FAIL\n  ${problems.join('\n  ')}`);
    process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
