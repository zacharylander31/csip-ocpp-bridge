// Week 5 fail-safe demo: the network link drops in the middle of a 3 kW
// control, and comes back before the control ends.
//
//   5 kW default -> 3 kW control -> link DOWN -> (3 s later) comms lost:
//   5 kW default -> link UP -> 3 kW control again -> control ends: 5 kW default
//
// One charger, so the charger's cap is the site limit. Exits non-zero on failure.
import { Bridge } from './bridge.js';
import { SimCharger } from './chargerSim.js';
import { CsipClient } from './csipClient.js';
import { Manager, SETTLE_MS } from './csms.js';
import { MockCsipServer } from './mockCsipServer.js';

const CSIP_PORT = 8083;
const OCPP_PORT = 9002;
const EV_MAX_W = 7400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    // Show the link going down and up, but not every GET.
    const csip = new MockCsipServer({ controls: [] }, (m) => {
        if (!m.startsWith('GET')) console.log(`[CSIP] ${m}`);
    });
    await csip.listen(CSIP_PORT);
    const now = csip.serverNow();
    csip.setScenario({
        defaultImportLimit: { value: 5000, multiplier: 0 },
        controls: [{ mRID: 'EVENING-PEAK', start: now + 3, duration: 15, importLimit: { value: 3, multiplier: 3 } }],
    });

    const manager = new Manager();
    await manager.listen(OCPP_PORT);
    const sim = new SimCharger({ id: 'CP1', endpoint: `ws://localhost:${OCPP_PORT}`, evMaxW: EV_MAX_W });
    const chargerReady = manager.waitForCharger('CP1');
    await sim.start();
    const charger = await chargerReady;

    // Short timings so the demo is quick; a real network polls about every 60 s.
    const bridge = new Bridge(new CsipClient(`http://localhost:${CSIP_PORT}`), [charger], {
        pollMs: 1000,
        tickMs: 250,
        commsLostAfterMs: 3000,
    });
    const t0 = Date.now();
    await bridge.start();

    await sleep(6000 - (Date.now() - t0));
    csip.setOffline(true);
    await sleep(12_000 - (Date.now() - t0));
    csip.setOffline(false);
    await sleep(22_000 - (Date.now() - t0));

    await bridge.stop();
    await sim.stop();
    await manager.close();
    await csip.close();

    // Same check as the other demos: after each change was acked, and until
    // the next one was sent, every reading must match that limit.
    const r = charger.readings;
    const changes = bridge.changes;
    const label = (c: (typeof changes)[number]) => `${c.limitW} ${c.source}${c.commsLost ? ' (COMMS LOST)' : ''}`;
    console.log(`\nPower drawn each second (W): [${r.map((x) => x.watts).join(', ')}]`);
    console.log(`Limits applied (W): [${changes.map(label).join(', ')}]`);

    const problems: string[] = [];
    const want = '5000,3000,5000 lost,3000,5000';
    const got = changes.map((c) => `${c.limitW}${c.commsLost ? ' lost' : ''}`).join();
    if (got !== want) problems.push(`expected ${want}, got ${got}`);
    changes.forEach((c, i) => {
        const until = changes[i + 1]?.sentAt ?? Infinity;
        const expectW = Math.min(EV_MAX_W, c.limitW ?? EV_MAX_W);
        const readings = r.filter((x) => x.at >= c.ackedAt + SETTLE_MS && x.at < until).map((x) => x.watts);
        if (readings.length === 0) problems.push(`no readings under ${label(c)}`);
        if (readings.some((w) => w !== expectW)) problems.push(`under ${label(c)} wanted ${expectW}, got [${readings}]`);
    });

    console.log(problems.length === 0
        ? 'RESULT: PASS - fell back to the default when the link dropped, and recovered when it came back'
        : `RESULT: FAIL\n  ${problems.join('\n  ')}`);
    process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
