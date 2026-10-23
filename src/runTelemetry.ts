// Telemetry demo: the bridge reports what the chargers drew back to the
// network, every postRate (5 s here, 300 s on real servers).
//
// Two chargers, site default 5 kW -> 3 kW control for 15 s -> default again,
// so the server should hear ~5000 W, then ~3000 W, then ~5000 W. Afterwards
// the server forgets the gateway's mirror (as Energex servers may), and the
// bridge must register again and still deliver every interval, in order.
// Exits non-zero on failure.
import { Bridge, type TelemetryInterval } from './bridge.js';
import { SimCharger } from './chargerSim.js';
import { CsipClient } from './csipClient.js';
import { Manager, type ManagedCharger } from './csms.js';
import { MockCsipServer } from './mockCsipServer.js';

// Different ports from the other demos, so they can run alongside.
const CSIP_PORT = 8084;
const OCPP_PORT = 9003;
const EV_MAX_W = 7400;
const CHARGER_IDS = ['CP1', 'CP2'];
const POST_RATE_SEC = 5;
const GATEWAY_LFDI = '3E4F45AB31EDFE5B67E343E5E4562E31984E23E5'; // the mock's pre-registered gateway

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const csip = new MockCsipServer({ controls: [] }, (m) => {
        // Only the telemetry traffic; the GETs for polling are noise here.
        if (m.includes('/mup') || m.includes('forgot')) console.log(`[CSIP] ${m}`);
    });
    await csip.listen(CSIP_PORT);
    // Start the control on an interval boundary and run it for three
    // intervals. The bridge's guess at server time can be up to a second out,
    // so the first and last may catch a bit of the 5 kW either side, but the
    // middle one is always a whole interval at 3 kW.
    const now = csip.serverNow();
    const controlStart = Math.ceil((now + 7) / POST_RATE_SEC) * POST_RATE_SEC;
    const controlEnd = controlStart + 3 * POST_RATE_SEC;
    csip.setScenario({
        defaultImportLimit: { value: 5000, multiplier: 0 },
        controls: [{ mRID: 'EVENING-PEAK', start: controlStart, duration: controlEnd - controlStart, importLimit: { value: 3, multiplier: 3 } }],
        mupPostRateSec: POST_RATE_SEC,
    });

    const manager = new Manager(() => {});
    await manager.listen(OCPP_PORT);
    const sims = CHARGER_IDS.map(
        (id) => new SimCharger({ id, endpoint: `ws://localhost:${OCPP_PORT}`, evMaxW: EV_MAX_W, log: () => {} }),
    );
    const chargersReady = Promise.all(CHARGER_IDS.map((id) => manager.waitForCharger(id)));
    await Promise.all(sims.map((s) => s.start()));
    const chargers = await chargersReady;

    const bridge = new Bridge(new CsipClient(`http://localhost:${CSIP_PORT}`), chargers, {
        pollMs: 5000,
        tickMs: 500,
    });
    await bridge.start();

    await sleep((controlEnd + 3 - csip.serverNow()) * 1000);
    csip.forgetMirrors();
    await sleep(13_000);

    await bridge.stop();
    await Promise.all(sims.map((s) => s.stop()));
    await manager.close();
    await csip.close();

    // ---- checks ----
    const problems: string[] = [];
    const measured = bridge.telemetry;
    const received = csip.telemetry;

    console.log('\nInterval (server time)   bridge measured   server received   expected');
    for (const t of measured) {
        const got = received.filter((r) => r.start === t.startSec);
        const want = expected(t, chargers, bridge);
        // Every charger reports in this demo, so a missing average is a failure.
        if (t.avgW === undefined) problems.push(`${t.startSec}: no charger average`);
        const avgW = t.avgW ?? NaN;
        const wantText = want.lo === want.hi ? `${want.lo}` : `${want.lo}..${want.hi} (limit changed)`;
        console.log(`${t.startSec}+${t.durationSec}s       ${String(Math.round(avgW)).padStart(6)} W        ${got.map((r) => `${r.watts} W`).join(', ').padStart(8) || '      -'}         ${wantText}`);

        if (avgW < want.lo || avgW > want.hi) {
            problems.push(`${t.startSec}: measured ${avgW} W, expected ${wantText}`);
        }
        if (got.length > 1) problems.push(`${t.startSec}: server received it ${got.length} times`);
        if (got.length === 1 && got[0].watts !== Math.round(avgW)) {
            problems.push(`${t.startSec}: server got ${got[0].watts} W, bridge measured ${avgW} W`);
        }
    }

    // Every interval delivered (the last may have been cut off by stop()).
    const undelivered = measured.slice(0, -1).filter((t) => !received.some((r) => r.start === t.startSec));
    if (undelivered.length > 0) problems.push(`never delivered: ${undelivered.map((t) => t.startSec).join(', ')}`);

    // In order and with no gaps: each starts where the previous one ended.
    for (let i = 1; i < received.length; i++) {
        const prev = received[i - 1];
        if (received[i].start !== prev.start + prev.duration) {
            problems.push(`gap or out of order: ${prev.start} then ${received[i].start}`);
        }
    }

    // Not vacuous: whole intervals were seen at both limits.
    const steady = measured.map((t) => expected(t, chargers, bridge)).filter((w) => w.lo === w.hi);
    for (const want of [5000, 3000]) {
        if (!steady.some((w) => w.lo === want)) problems.push(`no whole interval at ${want} W`);
    }

    // The mirror was registered again after the server forgot it, and
    // readings went to both the old and the new one.
    const mirrors = csip.registeredMirrors();
    const hrefs = new Set(received.map((r) => r.mirrorHref));
    if (!mirrors.has('/mup/2') || !hrefs.has('/mup/1') || !hrefs.has('/mup/2')) {
        problems.push(`expected readings on /mup/1 then /mup/2 after re-registering, got ${[...hrefs].join(', ')}`);
    }
    for (const [href, m] of mirrors) {
        if (m.roleFlags !== '45' || m.deviceLFDI !== GATEWAY_LFDI) {
            problems.push(`${href}: roleFlags ${m.roleFlags}, deviceLFDI ${m.deviceLFDI}`);
        }
    }

    console.log(problems.length === 0
        ? 'RESULT: PASS - every interval reported correctly, in order, including across a lost mirror'
        : `RESULT: FAIL\n  ${problems.join('\n  ')}`);
    process.exit(problems.length === 0 ? 0 : 1);
}

/**
 * What the chargers together should have averaged over an interval.
 * If no charger's limit changed during it, exactly the sum of what each car
 * can draw under its share. If one did, somewhere between the before and
 * after values. "During" includes the send -> ack window, when a reading in
 * flight may reflect either limit.
 */
function expected(t: TelemetryInterval, chargers: ManagedCharger[], bridge: Bridge): { lo: number; hi: number } {
    let before = 0;
    let after = 0;
    let changed = false;
    for (const charger of chargers) {
        const changes = bridge.changes.filter((c) => c.chargerId === charger.id);
        const shareAt = (ms: number) => changes.filter((c) => c.ackedAt <= ms).at(-1)?.limitW;
        const draw = (limitW: number | undefined) => Math.min(EV_MAX_W, limitW ?? EV_MAX_W);
        before += draw(shareAt(t.fromMs));
        after += draw(shareAt(t.toMs));
        if (changes.some((c) => c.sentAt < t.toMs && c.ackedAt >= t.fromMs)) changed = true;
    }
    if (!changed) return { lo: before, hi: before };
    return { lo: Math.min(before, after), hi: Math.max(before, after) };
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
