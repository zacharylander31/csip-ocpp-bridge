// `npm run check-csip`: runs Zach's CsipClient against the mock server in a
// few scenarios that real servers throw at you. Takes about 10 seconds.
import { CsipClient, type ActiveLimit } from './csipClient.js';
import { MockCsipServer, type Scenario } from './mockCsipServer.js';

const PORT = 8081;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;

function expect(name: string, got: ActiveLimit, want: ActiveLimit): void {
    const ok =
        got.importLimitW === want.importLimitW &&
        got.source === want.source &&
        (want.mRID === undefined || got.mRID === want.mRID);
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) console.log(`      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`);
}

async function scenario(
    title: string,
    server: MockCsipServer,
    s: Scenario,
    body: (client: CsipClient) => Promise<void>,
): Promise<void> {
    console.log(`\n# ${title}`);
    server.setScenario(s);
    const client = new CsipClient(BASE);
    try {
        await client.discover();
        await client.poll();
        await body(client);
    } catch (err) {
        failures++;
        console.log(`FAIL  threw: ${(err as Error).message}`);
    }
}

// Sleep until `t` (unix seconds on the server's clock) has clearly passed.
// /tm has 1-second resolution, so a client's view of server time can lag by
// up to 1 s; the 1.2 s margin allows for that.
async function sleepUntilServerTime(t: number, offsetSec: number): Promise<void> {
    await sleep(Math.max(0, (t - offsetSec) * 1000 - Date.now() + 1200));
}

async function main() {
    const server = new MockCsipServer({ controls: [] }, () => {}); // quiet
    await server.listen(PORT);
    const now = () => server.serverNow();

    {
        const start = now() + 2;
        await scenario('Timeline: default -> control -> default', server, {
            defaultImportLimit: { value: 5000, multiplier: 0 },
            controls: [{ mRID: 'CTRL-A', start, duration: 4, importLimit: { value: 3, multiplier: 3 } }],
        }, async (c) => {
            expect('before the control starts, the default applies',
                c.activeImportLimit(), { importLimitW: 5000, source: 'default' });

            await sleepUntilServerTime(start, 0);
            expect('control starts with no new poll (decide from start/duration, not EventStatus)',
                c.activeImportLimit(), { importLimitW: 3000, source: 'control', mRID: 'CTRL-A' });

            await sleepUntilServerTime(start + 4, 0);
            expect('control ends with no new poll, default is back',
                c.activeImportLimit(), { importLimitW: 5000, source: 'default' });
        });
    }

    // Near a boundary the client can't know the server's time to better than a
    // second, so it must use the stricter limit there: the control whenever the
    // server's real time is inside it, even if our estimate says otherwise. The
    // estimate's error depends on where within a second we polled, so poll at
    // a chosen point: just after a second ticks over, the estimate runs ahead
    // (ends early if careless); just before, it runs behind (starts late).
    // The mock's real time is this machine's clock (it only rounds /tm down).
    for (const [fraction, why] of [[0.1, 'ahead: must not end early'], [0.9, 'behind: must not start late']] as const) {
        const start = now() + 3;
        const end = start + 3;
        await scenario(`Boundaries with the estimate ${why}`, server, {
            defaultImportLimit: { value: 5000, multiplier: 0 },
            controls: [{ mRID: 'CTRL-EDGE', start, duration: end - start, importLimit: { value: 3, multiplier: 3 } }],
        }, async (c) => {
            await sleep((1000 + fraction * 1000 - (Date.now() % 1000)) % 1000);
            await c.poll();
            let inside = 0;
            let missed: string | undefined; // real time inside the control, but not given the control
            let tooLong: string | undefined; // well outside the control, but still given it
            while (Date.now() / 1000 < end + 1.6) {
                const real = Date.now() / 1000;
                const limit = c.activeImportLimit().importLimitW;
                if (real >= start && real < end) {
                    inside++;
                    if (limit !== 3000) missed ??= `${limit} W at ${(real - (real < start + 1.5 ? start : end)).toFixed(2)} s from the ${real < start + 1.5 ? 'start' : 'end'}`;
                } else if ((real < start - 1.2 || real >= end + 1.2) && limit !== 5000) {
                    tooLong ??= `${limit} W at ${(real < start ? real - start : real - end).toFixed(2)} s outside`;
                }
                await sleep(50);
            }
            const ok = inside > 20 && !missed && !tooLong;
            if (!ok) failures++;
            console.log(`${ok ? 'PASS' : 'FAIL'}  the control applies whenever the server's real time is inside it, and not 1.2 s past either end`);
            if (!ok) console.log(`      ${missed ? `inside but not capped: ${missed}` : ''}${tooLong ? ` held too long: ${tooLong}` : ''}${inside <= 20 ? ` only ${inside} samples inside` : ''}`);
        });
    }

    await scenario('Energy Queensland-style "ns2" prefix', server, {
        nsPrefix: 'ns2',
        defaultImportLimit: { value: 5000, multiplier: 0 },
        controls: [{ mRID: 'CTRL-B', start: now() - 5, duration: 60, importLimit: { value: 4200, multiplier: 0 } }],
    }, async (c) => {
        expect('reads opModImpLimW whatever the prefix',
            c.activeImportLimit(), { importLimitW: 4200, source: 'control', mRID: 'CTRL-B' });
    });

    {
        const offset = 3600; // server clock an hour ahead of this machine
        await scenario('Server clock 1 hour ahead of local clock', server, {
            clockOffsetSec: offset,
            defaultImportLimit: { value: 5000, multiplier: 0 },
            controls: [{ mRID: 'CTRL-C', start: Math.floor(Date.now() / 1000) + offset - 10, duration: 60, importLimit: { value: 25, multiplier: 2 } }],
        }, async (c) => {
            expect('uses server time from /tm, so the control is active',
                c.activeImportLimit(), { importLimitW: 2500, source: 'control', mRID: 'CTRL-C' });
        });
    }

    await scenario('No default control (dderc returns 404), no controls', server, {
        controls: [],
    }, async (c) => {
        expect('no limit at all',
            c.activeImportLimit(), { importLimitW: undefined, source: 'none' });
    });

    await server.close();
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
