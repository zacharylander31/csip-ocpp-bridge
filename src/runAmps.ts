// Tab B demo: amps-only chargers, single and three phase, and the 6 A minimum.
// Exits non-zero on failure. Port 9021.
//
// Chargers (all amps-only, all with a car that stops below 6 A per phase):
//   A1     OCPP 2.0.1, 1 phase                 configured rateUnit A, phases 1
//   A3     OCPP 1.6,   3 phase, car max 11 kW  configured rateUnit A, phases 3
//   NOMIN  OCPP 1.6,   3 phase                 like A3 but minAmpsPerPhase 0 (what goes wrong without it)
//   WRONG  OCPP 2.0.1, 1 phase                 misconfigured as rateUnit W: the charger rejects the cap
import { SimCharger } from './chargerSim.js';
import { DEFAULT_CHARGER_CONFIG, Manager, planCap, type ManagedCharger } from './csms.js';

const PORT = 9021;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ok = true;
function check(what: string, pass: boolean, detail = ''): void {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
    ok &&= pass;
}

// 1. The conversion on its own (no chargers needed).
function checkPlanCap(): void {
    const amps1 = { ...DEFAULT_CHARGER_CONFIG, rateUnit: 'A' as const, phases: 1 as const };
    const amps3 = { ...amps1, phases: 3 as const };
    const tenths = { ...amps1, ampStep: 0.1 };
    const cases = [
        { cfg: amps1, w: 3000, limit: 13, allowedW: 2990, paused: false }, // 13.04 A -> 13 A
        { cfg: amps3, w: 5000, limit: 7, allowedW: 4830, paused: false }, // 7.25 A/phase -> 7 A
        { cfg: amps3, w: 3000, limit: 0, allowedW: 0, paused: true }, // 4.35 A/phase < 6 A -> pause
        { cfg: amps1, w: 1380, limit: 6, allowedW: 1380, paused: false }, // exactly 6 A
        { cfg: amps1, w: 1379, limit: 0, allowedW: 0, paused: true },
        { cfg: tenths, w: 3000, limit: 13, allowedW: 2990, paused: false }, // 13.04 -> 13.0
        { cfg: tenths, w: 3010, limit: 13.0, allowedW: 2990, paused: false }, // 13.087 -> 13.0
        { cfg: tenths, w: 3013, limit: 13.1, allowedW: 3013, paused: false }, // 13.1 exactly, no float loss
        { cfg: DEFAULT_CHARGER_CONFIG, w: 2500.7, limit: 2500, allowedW: 2500, paused: false },
        { cfg: DEFAULT_CHARGER_CONFIG, w: 1000, limit: 0, allowedW: 0, paused: true }, // W charger, < 6 A
        { cfg: { ...DEFAULT_CHARGER_CONFIG, minAmpsPerPhase: 0 }, w: 1000, limit: 1000, allowedW: 1000, paused: false },
    ];
    for (const c of cases) {
        const p = planCap(c.w, c.cfg);
        check(
            `planCap ${c.w} W, ${c.cfg.rateUnit} ${c.cfg.phases}ph step ${c.cfg.ampStep} min ${c.cfg.minAmpsPerPhase}`,
            p.limit === c.limit && Math.abs(p.allowedW - c.allowedW) < 1e-6 && p.paused === c.paused,
            `${p.limit} ${p.unit}, allowed ${p.allowedW} W${p.paused ? ', paused' : ''}`,
        );
    }
}

// The readings received between `from` (when the change was acked) and `to`.
// A reading sent just before the charger replied can be handled a moment
// after the reply resolves, so skip SETTLE_MS after the ack.
const SETTLE_MS = 300;
function readingsBetween(c: ManagedCharger, from: number, to: number): number[] {
    return c.readings.filter((r) => r.at >= from + SETTLE_MS && r.at < to).map((r) => r.watts);
}

// Three-phase sims report floor(W/3) per phase, so the sum can be up to 2 W low.
const near = (values: number[], expected: number) =>
    values.length > 0 && values.every((w) => w <= expected && w >= expected - 2);

async function main() {
    console.log('--- conversion ---');
    checkPlanCap();

    console.log('\n--- chargers ---');
    const manager = new Manager(undefined, {
        chargers: {
            A1: { rateUnit: 'A', phases: 1 },
            A3: { rateUnit: 'A', phases: 3 },
            NOMIN: { rateUnit: 'A', phases: 3, minAmpsPerPhase: 0 },
            WRONG: { rateUnit: 'W', phases: 1 },
        },
    });
    await manager.listen(PORT);
    const endpoint = `ws://localhost:${PORT}`;
    const car = { acceptsW: false, evMinAmpsPerPhase: 6 };
    const sims = [
        new SimCharger({ id: 'A1', protocol: '2.0.1', endpoint, phases: 1, evMaxW: 7400, ...car }),
        new SimCharger({ id: 'A3', protocol: '1.6', endpoint, phases: 3, evMaxW: 11000, ...car }),
        new SimCharger({ id: 'NOMIN', protocol: '1.6', endpoint, phases: 3, evMaxW: 11000, ...car }),
        new SimCharger({ id: 'WRONG', protocol: '2.0.1', endpoint, phases: 1, evMaxW: 7400, ...car }),
    ];
    const ready = Promise.all(sims.map((s) => manager.waitForCharger(s.id)));
    await Promise.all(sims.map((s) => s.start()));
    const [a1, a3, nomin, wrong] = await ready;
    await sleep(1500);

    // Step 1: 3000 W each.
    const [s1, s3, sn, sw] = await Promise.all([a1, a3, nomin, wrong].map((c) => c.capPower(3000)));
    const t1 = Date.now();
    await sleep(3000);
    const t2 = Date.now();
    check('A1 accepts 13 A', s1 === 'Accepted' && a1.lastCap?.limit === 13 && a1.lastCap.unit === 'A');
    check('A1 draws 2990 W', near(readingsBetween(a1, t1, t2), 2990), readingsBetween(a1, t1, t2).join(','));
    check('A3 paused (3000 W < 6 A x 3 phases)', s3 === 'Accepted' && a3.lastCap?.paused === true && a3.lastCap.allowedW === 0);
    check('A3 draws 0 W', near(readingsBetween(a3, t1, t2), 0), readingsBetween(a3, t1, t2).join(','));
    // Without the minimum the charger gets 4 A/phase: we'd think it may draw
    // 2760 W, but the car stops, and that power is wasted without anyone knowing.
    check('NOMIN sent 4 A, thinks 2760 W allowed', sn === 'Accepted' && nomin.lastCap?.limit === 4 && nomin.lastCap.allowedW === 2760 && !nomin.lastCap.paused);
    check('NOMIN car actually draws 0 W', near(readingsBetween(nomin, t1, t2), 0));
    check('WRONG (W sent to amps-only charger) is Rejected', sw === 'Rejected' && !wrong.compliant);
    check('WRONG still draws full power', near(readingsBetween(wrong, t1, t2), 7400));

    // Step 2: 5000 W each.
    await Promise.all([a1, a3].map((c) => c.capPower(5000)));
    const t3 = Date.now();
    await sleep(3000);
    const t4 = Date.now();
    check('A1 21 A -> 4830 W', a1.lastCap?.limit === 21 && near(readingsBetween(a1, t3, t4), 4830), readingsBetween(a1, t3, t4).join(','));
    check('A3 7 A/phase -> 4830 W', a3.lastCap?.limit === 7 && near(readingsBetween(a3, t3, t4), 4830), readingsBetween(a3, t3, t4).join(','));

    // Step 3: caps removed.
    await Promise.all([a1, a3].map((c) => c.removeCap()));
    const t5 = Date.now();
    await sleep(3000);
    const t6 = Date.now();
    check('A1 back to 7400 W', near(readingsBetween(a1, t5, t6), 7400));
    check('A3 back to 11000 W', near(readingsBetween(a3, t5, t6), 11000), readingsBetween(a3, t5, t6).join(','));

    await Promise.all(sims.map((s) => s.stop()));
    await manager.close();

    console.log(ok ? '\nRESULT: PASS - amps, three phase and the 6 A minimum all work' : '\nRESULT: FAIL');
    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
