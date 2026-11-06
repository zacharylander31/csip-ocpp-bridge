// `npm run unplug-demo` (port 9080 OCPP): a car leaves and another arrives,
// with a site meter. Exits non-zero on failure.
//
// Two chargers (CP1 OCPP 2.0.1, CP2 OCPP 1.6), house 1000 W, site limit
// 5000 W, so each gets (5000 - 1000) / 2 = 2000 W.
//
// The bug this guards against: when a car stopped, its last reading (2000 W)
// kept counting for chargerIdleAfterMs (15 s). The house then looked 2000 W
// smaller, every charger's cap went up to 3000 W, and a car plugging back in
// during those 15 s started at 3000 W: site 1000 + 3000 + 3000 = 7000 W, over
// the 5000 W limit until its first reading came in.
//
// Now the charger's StopTransaction (1.6) / TransactionEvent Ended (2.0.1)
// counts as 0 W at once. Checks, for each protocol: the other charger stays
// at 2000 W (no phantom room), the car that comes back gets 2000 W, and the
// site is never over the limit.
import { Bridge } from './bridge.js';
import { SimCharger } from './chargerSim.js';
import { Manager } from './csms.js';
import type { ActiveLimit, LimitSource } from './limitSource.js';
import { SimSiteMeter } from './siteMeterSim.js';

const OCPP_PORT = 9080;
const LIMIT_W = 5000;
const HOUSE_W = 1000;
const SHARE_W = (LIMIT_W - HOUSE_W) / 2;
const STEP_TIMEOUT_MS = 10_000;
const HOLD_MS = 2000;
// Well inside chargerIdleAfterMs (15 s), where the old bug lived.
const AWAY_MS = 6000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const problems: string[] = [];
const logs: string[] = [];

// The network's limit never changes here; this demo is about the chargers.
const fixedLimit: LimitSource = {
    refresh: async () => {},
    get lastUpdatedAt() {
        return Date.now();
    },
    activeImportLimit: (): ActiveLimit => ({ importLimitW: LIMIT_W, source: 'default' }),
    defaultImportLimit: (): ActiveLimit => ({ importLimitW: LIMIT_W, source: 'default' }),
};

const manager = new Manager((m) => logs.push(m));
await manager.listen(OCPP_PORT);
const endpoint = `ws://localhost:${OCPP_PORT}`;
const cp1 = new SimCharger({ id: 'CP1', protocol: '2.0.1', endpoint, log: () => {} });
const cp2 = new SimCharger({ id: 'CP2', protocol: '1.6', endpoint, log: () => {} });
const sims = [cp1, cp2];
const ready = Promise.all(['CP1', 'CP2'].map((id) => manager.waitForCharger(id)));
await Promise.all(sims.map((s) => s.start()));
const chargers = await ready;

const meter = new SimSiteMeter(sims, { houseW: HOUSE_W });
const bridge = new Bridge(fixedLimit, chargers, { siteMeter: meter, pollMs: 1000, tickMs: 500, log: (m) => logs.push(m) });
await bridge.start();

// The site's true power, sampled all the time.
let watching = false;
const overs: string[] = [];
const watcher = setInterval(() => {
    const site = meter.siteW();
    if (watching && site > LIMIT_W) overs.push(`${site} W (CP1 ${cp1.currentPowerW()}, CP2 ${cp2.currentPowerW()})`);
}, 100);

// Wait until `sim` draws `watts` and holds it.
async function expectDraw(sim: SimCharger, watts: number, what: string): Promise<void> {
    const startedAt = Date.now();
    let heldSince: number | undefined;
    while (Date.now() - startedAt < STEP_TIMEOUT_MS + HOLD_MS) {
        if (sim.currentPowerW() !== watts) heldSince = undefined;
        else if (heldSince === undefined) heldSince = Date.now();
        else if (Date.now() - heldSince >= HOLD_MS) {
            console.log(`OK: ${what}: ${sim.id} draws ${watts} W, site ${meter.siteW()} W`);
            return;
        }
        await sleep(100);
    }
    problems.push(`${what}: ${sim.id} draws ${sim.currentPowerW()} W, expected ${watts} W`);
}

// While the car is away, the other charger must not be raised: there's no room.
async function staysAt(sim: SimCharger, watts: number, forMs: number, what: string): Promise<void> {
    const seen = new Set<number>();
    for (const end = Date.now() + forMs; Date.now() < end; ) {
        seen.add(sim.currentPowerW());
        await sleep(100);
    }
    if (seen.size !== 1 || !seen.has(watts)) problems.push(`${what}: ${sim.id} drew ${[...seen].join(', ')} W, expected only ${watts} W`);
    else console.log(`OK: ${what}: ${sim.id} stayed at ${watts} W for ${forMs / 1000} s`);
}

async function leaveAndReturn(away: SimCharger, other: SimCharger, stopWord: string): Promise<void> {
    console.log(`--- ${away.id} (OCPP ${away.id === 'CP1' ? '2.0.1' : '1.6'}): car leaves ---`);
    await away.unplug();
    await staysAt(other, SHARE_W, AWAY_MS, `${away.id} away`);
    if (!logs.some((l) => l.startsWith(`${away.id} ${stopWord}: counting it as 0 W`))) {
        problems.push(`no "${away.id} ${stopWord}: counting it as 0 W" log line`);
    }
    console.log(`--- ${away.id}: a car plugs in ${AWAY_MS / 1000} s later ---`);
    await away.plugIn();
    await expectDraw(away, SHARE_W, `${away.id} back`);
    await expectDraw(other, SHARE_W, `${away.id} back`);
}

console.log(`--- both charging: house ${HOUSE_W} W, limit ${LIMIT_W} W ---`);
await expectDraw(cp1, SHARE_W, 'start');
await expectDraw(cp2, SHARE_W, 'start');
watching = true;

await leaveAndReturn(cp2, cp1, 'transaction stopped'); // 1.6: StopTransaction
await leaveAndReturn(cp1, cp2, 'transaction ended'); // 2.0.1: TransactionEvent Ended

clearInterval(watcher);
for (const o of overs.slice(0, 5)) problems.push(`site over the ${LIMIT_W} W limit: ${o}`);
if (overs.length > 5) problems.push(`... and ${overs.length - 5} more samples over the limit`);
await bridge.stop();
meter.stop();
await Promise.all(sims.map((s) => s.stop()));
await manager.close();

if (problems.length > 0) {
    console.log('RESULT: FAIL');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
}
console.log('RESULT: PASS - a car leaving counts as 0 W at once, and a car arriving never takes the site over the limit');
process.exit(0);
