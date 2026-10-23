// v0.1 demo: Open Dynamic Export's MQTT output -> bridge -> two OCPP chargers.
//
// No real ODE here: an in-process MQTT broker (aedes) and a fake ODE that
// publishes ODE-shaped messages every second, as real ODE does. Timeline
// (seconds from the first message):
//    0  default 5 kW                          -> 2500 W each
//    8  control EVENING-PEAK 3 kW until 34    -> 1500 W each
//   10  bad messages mixed in (must be ignored)
//   14  only bad messages from now on (must not count as "alive")
//   18  broker goes down
//  ~19  comms lost (5 s without a valid message) -> fail-safe default, 2500 W each
//   22  broker back up; 23 valid messages again  -> 1500 W each (control still on)
//   34  control ends                          -> 2500 W each
// Exits non-zero on failure.
import net from 'node:net';
import { Aedes } from 'aedes';
import { Bridge } from './bridge.js';
import { SimCharger } from './chargerSim.js';
import { Manager } from './csms.js';
import { OdeMqttSource } from './odeMqttSource.js';

// Tab A's ports (8090-8099 / 9010-9019), so this runs alongside the other demos.
const MQTT_PORT = 8090;
const OCPP_PORT = 9010;
const EV_MAX_W = 7400;
const CHARGER_IDS = ['CP1', 'CP2'];
const TOPIC = 'limits'; // ODE's publish.mqtt.topic; the csipAus data goes to limits/csipAus

const CONTROL = { mRID: 'EVENING-PEAK', fromSec: 8, toSec: 34, importLimitW: 3000 };
const DEFAULT_IMPORT_W = 5000;
const BAD_MIXED_IN_FROM_SEC = 10;
const VALID_STOPS_AT_SEC = 14;
const BROKER_DOWN_AT_SEC = 18;
const BROKER_UP_AT_SEC = 22;
const VALID_RESUMES_AT_SEC = 23;
const END_AT_SEC = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// An MQTT broker on MQTT_PORT that can be stopped and started again.
class Broker {
    private aedes?: Aedes;
    private server?: net.Server;

    async start(): Promise<void> {
        this.aedes = await Aedes.createBroker();
        this.server = net.createServer(this.aedes.handle);
        await new Promise<void>((resolve) => this.server!.listen(MQTT_PORT, resolve));
    }

    async stop(): Promise<void> {
        const { aedes, server } = this;
        this.aedes = this.server = undefined;
        // Closing aedes disconnects its clients, which lets the server close.
        await new Promise<void>((resolve) => aedes?.close(() => resolve()) ?? resolve());
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    }

    publish(topic: string, payload: string): void {
        this.aedes?.publish({ cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain: false, dup: false }, () => {});
    }
}

// What real ODE would publish at `atMs` (see odeMqttSource.ts and
// plans/notes/tab-a.md for the format).
function odeMessages(atMs: number, t0: number): { main: string; csipAus: string } {
    const start = t0 + CONTROL.fromSec * 1000;
    const end = t0 + CONTROL.toSec * 1000;
    const active = start <= atMs && atMs < end;
    const importW = active ? CONTROL.importLimitW : DEFAULT_IMPORT_W;
    const iso = (ms: number) => new Date(ms).toISOString();
    // ODE lists active and upcoming controls; finished ones drop off.
    const importSchedules = atMs < end
        ? [{
            startInclusive: iso(start),
            endExclusive: iso(end),
            effectiveStartInclusive: iso(start),
            effectiveEndExclusive: iso(end),
            mRID: CONTROL.mRID,
            derControlBase: { opModImpLimW: { value: CONTROL.importLimitW / 1000, multiplier: 3 } },
            responseRequired: '03',
            replyToHref: '/rsps',
        }]
        : [];
    return {
        // ODE's main topic; the source ignores it (see odeMqttSource.ts).
        main: JSON.stringify({
            opModEnergize: { value: true, source: 'csipAus' },
            opModConnect: { value: true, source: 'csipAus' },
            opModImpLimW: { value: importW, source: 'csipAus' },
        }),
        csipAus: JSON.stringify({
            limit: { source: 'csipAus', opModEnergize: true, opModConnect: true, opModExpLimW: 5000, opModImpLimW: importW },
            setGradW: 27,
            schedules: {
                opModExpLimW: [], opModGenLimW: [], opModImpLimW: importSchedules,
                opModLoadLimW: [], opModEnergize: [], opModConnect: [],
            },
        }),
    };
}

// Each would change the limit if it got through: to 0, 200 or 100 W each.
const BAD_MESSAGES = [
    'not json {',
    JSON.stringify({ limit: { opModImpLimW: -100 }, schedules: { opModImpLimW: [] } }),
    JSON.stringify({ limit: { opModImpLimW: '400' }, schedules: { opModImpLimW: [] } }),
    JSON.stringify({ limit: { opModImpLimW: 400 } }), // no schedules
    JSON.stringify({ limit: { opModImpLimW: 200 }, schedules: { opModImpLimW: [{ mRID: 'X', effectiveStartInclusive: 'soon' }] } }),
    JSON.stringify([1, 2, 3]),
];

async function main() {
    const broker = new Broker();
    await broker.start();

    const manager = new Manager();
    await manager.listen(OCPP_PORT);
    const sims = CHARGER_IDS.map(
        (id) => new SimCharger({ id, endpoint: `ws://localhost:${OCPP_PORT}`, evMaxW: EV_MAX_W }),
    );
    const chargersReady = Promise.all(CHARGER_IDS.map((id) => manager.waitForCharger(id)));
    await Promise.all(sims.map((s) => s.start()));
    const chargers = await chargersReady;

    const source = new OdeMqttSource({ url: `mqtt://localhost:${MQTT_PORT}`, topic: TOPIC, commsLostAfterMs: 5000 });
    source.start();

    // The fake ODE: one message a second, following the timeline.
    const t0 = Date.now();
    let fakeOdeRunning = true;
    let badIndex = 0;
    const fakeOde = (async () => {
        let brokerUp = true;
        for (let n = 0; fakeOdeRunning; n++) {
            const now = Date.now();
            const sec = (now - t0) / 1000;
            if (brokerUp && sec >= BROKER_DOWN_AT_SEC && sec < BROKER_UP_AT_SEC) {
                console.log('[DEMO] broker going down');
                await broker.stop();
                brokerUp = false;
            } else if (!brokerUp && sec >= BROKER_UP_AT_SEC) {
                console.log('[DEMO] broker back up');
                await broker.start();
                brokerUp = true;
            }
            const valid = sec < VALID_STOPS_AT_SEC || sec >= VALID_RESUMES_AT_SEC;
            if (valid) {
                const m = odeMessages(now, t0);
                broker.publish(TOPIC, m.main);
                broker.publish(source.csipAusTopic, m.csipAus);
            }
            if (sec >= BAD_MIXED_IN_FROM_SEC && sec < VALID_RESUMES_AT_SEC) {
                broker.publish(source.csipAusTopic, BAD_MESSAGES[badIndex++ % BAD_MESSAGES.length]);
            }
            await sleep(t0 + (n + 1) * 1000 - Date.now()); // on the second, without drift
        }
    })();

    const bridge = new Bridge(source, chargers, { pollMs: 1000, tickMs: 500 });
    await bridge.start();
    await sleep(t0 + END_AT_SEC * 1000 - Date.now());

    await bridge.stop();
    fakeOdeRunning = false;
    await fakeOde;
    await source.stop();
    await Promise.all(sims.map((s) => s.stop()));
    await manager.close();
    await broker.stop();

    // Like runBridge.ts's check: after each change was acked, and until the
    // next change to that charger was sent, every reading must equal what the
    // car can draw under its share. Readings between send and ack are
    // ambiguous (one may be in flight) and skipped.
    console.log();
    const problems: string[] = [];
    const wantShares = '2500,1500,2500,1500,2500';
    const wantCommsLost = 'false,false,true,false,false';
    for (const charger of chargers) {
        const r = charger.readings;
        const changes = bridge.changes.filter((c) => c.chargerId === charger.id);
        console.log(`${charger.id} power each second (W): [${r.map((x) => x.watts).join(', ')}]`);
        console.log(`${charger.id} shares applied (W):    [${changes.map((c) => `${c.limitW} of ${c.siteLimitW} ${c.commsLost ? 'FAIL-SAFE ' : ''}${c.source}`).join(', ')}]`);

        const shares = changes.map((c) => c.limitW).join();
        if (shares !== wantShares) problems.push(`${charger.id}: expected shares ${wantShares}, got ${shares}`);
        const lost = changes.map((c) => c.commsLost).join();
        if (lost !== wantCommsLost) problems.push(`${charger.id}: expected comms lost ${wantCommsLost}, got ${lost}`);
        changes.forEach((c, i) => {
            const until = changes[i + 1]?.sentAt ?? Infinity;
            const want = Math.min(EV_MAX_W, c.limitW ?? EV_MAX_W);
            // Strictly after the ack: a reading stamped in the same millisecond
            // may have arrived just before the reply.
            const under = r.filter((x) => x.at > c.ackedAt && x.at < until);
            const got = under.map((x) => x.watts);
            const sec = (ms: number) => ((ms - t0) / 1000).toFixed(2);
            if (got.length === 0) problems.push(`${charger.id}: no readings under share ${c.limitW}`);
            if (got.some((w) => w !== want)) {
                problems.push(`${charger.id}: under share ${c.limitW} (sent ${sec(c.sentAt)} s, acked ${sec(c.ackedAt)} s) wanted ${want}, got [${under.map((x) => `${x.watts}@${sec(x.at)}`)}]`);
            }
        });

        // The fail-safe must have kicked in after the last valid message, not before.
        const failSafe = changes.find((c) => c.commsLost);
        const lastValidBefore = t0 + (VALID_STOPS_AT_SEC - 1) * 1000;
        if (failSafe && failSafe.sentAt < lastValidBefore + source.commsLostAfterMs) {
            problems.push(`${charger.id}: fail-safe after ${(failSafe.sentAt - lastValidBefore) / 1000} s, before the ${source.commsLostAfterMs / 1000} s timeout`);
        }
    }
    console.log(`bad messages ignored: ${source.rejectedMessages}`);
    if (source.rejectedMessages === 0) problems.push('no bad messages were rejected (were any sent?)');

    console.log(problems.length === 0
        ? 'RESULT: PASS - followed ODE, ignored bad messages, fell back to the default when ODE went silent, and recovered'
        : `RESULT: FAIL\n  ${problems.join('\n  ')}`);
    process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
