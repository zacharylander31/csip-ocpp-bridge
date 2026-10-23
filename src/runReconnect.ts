// Tab B demo: chargers that reboot (and forget their profiles) or lose their
// connection get their cap re-sent, and only count as compliant once they've
// accepted it. Exits non-zero on failure. Port 9022.
//
//   R16   OCPP 1.6,   1 phase, takes W
//   R201  OCPP 2.0.1, 3 phase, amps-only, car max 11 kW
//
// 1. Cap both at 4600 W (R201: 6 A/phase = 4140 W).
// 2. R16 reboots and forgets its profile -> boots -> cap re-sent -> compliant.
// 3. R201 loses its connection (keeps its profile, no boot) -> re-sent after the boot wait.
// 4. R16 reboots, and while it's offline the cap changes to 2000 W -> it gets 2000 W on return.
// 5. Cap removed, R16 reboots -> "no cap" re-sent (Unknown = fine) -> full power.
import { SimCharger } from './chargerSim.js';
import { Manager, SETTLE_MS, type ManagedCharger } from './csms.js';

const PORT = 9022;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ok = true;
function check(what: string, pass: boolean, detail = ''): void {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
    ok &&= pass;
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
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

// Readings received after `from` (when a change was acked). A reading sent
// just before the charger replied can be handled a moment after the reply
// resolves, so skip SETTLE_MS after the ack.
const readingsSince = (c: ManagedCharger, from: number) =>
    c.readings.filter((r) => r.at >= from + SETTLE_MS).map((r) => r.watts);
// Three-phase sims report floor(W/3) per phase, so the sum can be up to 2 W low.
const allNear = (values: number[], expected: number) =>
    values.length > 0 && values.every((w) => w <= expected && w >= expected - 2);

async function main() {
    const manager = new Manager(undefined, { chargers: { R201: { rateUnit: 'A', phases: 3, maxVoltage: 230 } } }); // sims' grid is exactly 230 V
    await manager.listen(PORT);
    const endpoint = `ws://localhost:${PORT}`;
    const r16Sim = new SimCharger({ id: 'R16', protocol: '1.6', endpoint, evMaxW: 7400 });
    const r201Sim = new SimCharger({ id: 'R201', protocol: '2.0.1', endpoint, phases: 3, acceptsW: false, evMaxW: 11000 });
    const ready = Promise.all([manager.waitForCharger('R16'), manager.waitForCharger('R201')]);
    await Promise.all([r16Sim.start(), r201Sim.start()]);
    const [r16, r201] = await ready;
    await sleep(1000);

    console.log('\n--- 1. cap both at 4600 W ---');
    await Promise.all([r16.capPower(4600), r201.capPower(4600)]);
    check('both compliant', r16.compliant && r201.compliant);
    const r201CappedAt = r201.compliantSince!;

    console.log('\n--- 2. R16 reboots and forgets its profile ---');
    const reboot = r16Sim.reboot(500);
    await waitFor('R16 offline', () => !r16.connected);
    check('R16 not compliant while offline', !r16.compliant);
    await reboot;
    const backAt = Date.now();
    await waitFor('R16 compliant again', () => r16.compliant);
    const resentAt = r16.compliantSince!;
    console.log(`     cap re-sent ${resentAt - backAt} ms after the charger came back`);
    await sleep(2500);
    check('R16 at 4600 W after the re-send', allNear(readingsSince(r16, resentAt), 4600), readingsSince(r16, resentAt).join(','));

    console.log('\n--- 3. R201 loses its connection (no reboot) ---');
    const blip = r201Sim.reconnect(500);
    await waitFor('R201 offline', () => !r201.connected);
    await blip;
    await waitFor('R201 connected', () => r201.connected);
    check('R201 not compliant until re-sent', !r201.compliant);
    await waitFor('R201 compliant again', () => r201.compliant);
    await sleep(1500);
    // Its profile survived, so it never went over: every reading since the first cap is 4140 W.
    check('R201 stayed at 4140 W throughout', allNear(readingsSince(r201, r201CappedAt), 4140), readingsSince(r201, r201CappedAt).join(','));

    console.log('\n--- 4. cap changes to 2000 W while R16 is offline ---');
    const reboot2 = r16Sim.reboot(1500);
    await waitFor('R16 offline', () => !r16.connected);
    let threw = false;
    try {
        await r16.capPower(2000);
    } catch (err) {
        threw = true;
        console.log(`     capPower while offline: ${(err as Error).message}`);
    }
    check('capPower throws while offline', threw);
    await reboot2;
    await waitFor('R16 compliant again', () => r16.compliant);
    const resent2At = r16.compliantSince!;
    await sleep(2500);
    check('R16 got the new 2000 W cap', r16.lastCap?.limit === 2000 && allNear(readingsSince(r16, resent2At), 2000), readingsSince(r16, resent2At).join(','));

    console.log('\n--- 5. cap removed, then R16 reboots ---');
    await r16.removeCap();
    await r16Sim.reboot(500);
    await waitFor('R16 compliant again', () => r16.compliant);
    const resent3At = r16.compliantSince!;
    await sleep(2500);
    check('R16 at full power, no cap', r16.lastCap === undefined && allNear(readingsSince(r16, resent3At), 7400), readingsSince(r16, resent3At).join(','));

    await Promise.all([r16Sim.stop(), r201Sim.stop()]);
    await manager.close();

    console.log(ok ? '\nRESULT: PASS - caps survive reboots and reconnects' : '\nRESULT: FAIL');
    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
