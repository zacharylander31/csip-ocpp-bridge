// Site meter demo: the network's limit is for the whole site, so the
// chargers only get what the house isn't using.
//
// Two chargers (cars want 7.4 kW each), house at 1 kW, site default 5 kW:
//   start           house  1000, limit 5000 -> chargers 4000 -> 2000 each
//   kettle on       house  3000, limit 5000 -> chargers 2000 -> 1000 each
//   kettle off      house  1000, limit 5000 -> chargers 4000 -> 2000 each
//   3 kW control    house  1000, limit 3000 -> chargers 2000 -> 1000 each
//   solar exporting house -1500, limit 3000 -> chargers 4500 -> 2200 each (rounded down to 100 W)
//   control ends    house -1500, limit 5000 -> chargers 6500 -> 3200 each
// Checks the shares, that the site meter never reads over the limit except
// for a moment after something changes, and that site telemetry arrives.
// Exits non-zero on failure.
import { Bridge } from './bridge.js';
import { SimCharger } from './chargerSim.js';
import { CsipClient } from './csipClient.js';
import { Manager } from './csms.js';
import { MockCsipServer } from './mockCsipServer.js';
import { SimSiteMeter } from './siteMeterSim.js';

// Different ports from the other demos, so they can run alongside.
const CSIP_PORT = 8085;
const OCPP_PORT = 9004;
const EV_MAX_W = 7400;
const CHARGER_IDS = ['CP1', 'CP2'];
const POST_RATE_SEC = 5;
const EXPECTED_SHARES = [2000, 1000, 2000, 1000, 2200, 3200];
// How long the site may be over the limit after the house load or the limit
// changes: one site meter reading to notice, one tick to act, one charger
// round trip, plus the up-to-1 s error in the bridge's idea of server time.
const REACTION_ALLOWANCE_MS = 3000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function main() {
    const csip = new MockCsipServer({ controls: [] }, () => {}); // quiet
    await csip.listen(CSIP_PORT);
    const controlStart = csip.serverNow() + 16;
    const controlEnd = controlStart + 10;
    csip.setScenario({
        defaultImportLimit: { value: 5000, multiplier: 0 },
        controls: [{ mRID: 'EVENING-PEAK', start: controlStart, duration: controlEnd - controlStart, importLimit: { value: 3, multiplier: 3 } }],
        mupPostRateSec: POST_RATE_SEC,
    });

    // No minimum current: this demo's 1000 W shares are below a real car's 6 A (1380 W).
    const manager = new Manager(() => {}, { defaults: { minAmpsPerPhase: 0 } });
    await manager.listen(OCPP_PORT);
    const sims = CHARGER_IDS.map(
        (id) => new SimCharger({ id, endpoint: `ws://localhost:${OCPP_PORT}`, evMaxW: EV_MAX_W, log: () => {} }),
    );
    const chargersReady = Promise.all(CHARGER_IDS.map((id) => manager.waitForCharger(id)));
    await Promise.all(sims.map((s) => s.start()));
    const chargers = await chargersReady;
    // Start once every charger has reported. Before that, the bridge counts a
    // charger's draw as house load (the safe way round) and holds the
    // chargers lower for a second: correct, but not what this demo shows.
    while (chargers.some((c) => c.readings.length === 0)) await sleep(100);
    const meter = new SimSiteMeter(sims, { houseW: 1000 });

    const bridge = new Bridge(new CsipClient(`http://localhost:${CSIP_PORT}`), chargers, {
        pollMs: 5000,
        tickMs: 500,
        siteMeter: meter,
    });
    await bridge.start();

    // Local times when the limit may drop or the house load rises; the site
    // can be over the limit just after these.
    const events: { at: number; what: string }[] = [];
    const house = (watts: number, what: string) => {
        console.log(`[DEMO] ${what}: house load ${watts} W`);
        meter.setHouseW(watts);
        events.push({ at: Date.now(), what });
    };
    // The mock's clock is this machine's clock, so server seconds -> local ms is just * 1000.
    events.push({ at: controlStart * 1000, what: '3 kW control starts' });

    await sleep(5000);
    house(3000, 'kettle on');
    await sleep(5000);
    house(1000, 'kettle off');
    await sleep((controlStart + 5) * 1000 - Date.now());
    house(-1500, 'solar exporting');
    await sleep((controlEnd + 6) * 1000 - Date.now());

    await bridge.stop();
    meter.stop();
    await Promise.all(sims.map((s) => s.stop()));
    await manager.close();
    await csip.close();

    // ---- checks ----
    const problems: string[] = [];
    console.log();
    for (const charger of chargers) {
        const changes = bridge.changes.filter((c) => c.chargerId === charger.id);
        const shares = changes.map((c) => c.limitW);
        console.log(`${charger.id} shares (W): [${changes.map((c) => `${c.limitW} (limit ${c.siteLimitW}, house ${c.houseW})`).join(', ')}]`);
        if (shares.join() !== EXPECTED_SHARES.join()) {
            problems.push(`${charger.id}: expected shares ${EXPECTED_SHARES.join()}, got ${shares.join()}`);
        }
    }

    // The site meter against the limit in force when it read, from when the
    // bridge first capped the chargers (before that they're uncapped).
    const firstAck = Math.max(...CHARGER_IDS.map((id) => bridge.changes.find((c) => c.chargerId === id)?.ackedAt ?? Infinity));
    const limitAt = (ms: number) => (ms >= controlStart * 1000 && ms < controlEnd * 1000 ? 3000 : 5000);
    const over = meter.readings.filter((r) => r.at > firstAck && r.watts > limitAt(r.at));
    if (firstAck === Infinity) problems.push('the bridge never capped both chargers');
    const unexplained = over.filter(
        (r) => !events.some((e) => r.at >= e.at - 1000 && r.at < e.at + REACTION_ALLOWANCE_MS),
    );
    console.log(`site meter: ${meter.readings.length} readings, ${over.length} over the limit just after a change, ${unexplained.length} otherwise`);
    for (const r of unexplained) problems.push(`site read ${r.watts} W at +${r.at - events[0].at} ms, limit ${limitAt(r.at)} W`);

    // Site telemetry: a site mirror (roleFlags 03) next to the chargers' (45),
    // and what the server got matches what the bridge measured.
    const roles = [...csip.registeredMirrors().values()].map((m) => m.roleFlags).sort();
    if (roles.join() !== '03,45') problems.push(`expected mirrors with roleFlags 03 and 45, got ${roles.join()}`);
    const siteHref = [...csip.registeredMirrors()].find(([, m]) => m.roleFlags === '03')?.[0];
    console.log('\nInterval (server time)   site measured   site received');
    for (const t of bridge.telemetry) {
        const got = csip.telemetry.filter((r) => r.mirrorHref === siteHref && r.start === t.startSec);
        console.log(`${t.startSec}+${t.durationSec}s       ${String(Math.round(t.siteAvgW ?? NaN)).padStart(6)} W     ${got.map((r) => `${r.watts} W`).join(', ') || '-'}`);
        if (t.siteAvgW === undefined) problems.push(`${t.startSec}: no site average`);
        else if (t.postedAt && (got.length !== 1 || got[0].watts !== Math.round(t.siteAvgW))) {
            problems.push(`${t.startSec}: site measured ${t.siteAvgW} W, server got [${got.map((r) => r.watts)}]`);
        }
    }
    if (bridge.telemetry.filter((t) => t.postedAt).length < 3) problems.push('fewer than 3 telemetry intervals posted');

    console.log(problems.length === 0
        ? 'RESULT: PASS - chargers got only what the house left, and site telemetry was posted'
        : `RESULT: FAIL\n  ${problems.join('\n  ')}`);
    process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
