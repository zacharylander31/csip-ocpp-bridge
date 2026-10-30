// `npm run charger-sim -- --url ws://localhost:9030/CP1`: one simulated
// charger, on its own, so you can try the bridge (`npm start`) without a real
// charger. It connects, boots, starts charging at full power and reports
// meter values every second, and obeys whatever cap the bridge sends.
//
// Options (all but --url optional):
//   --url ws://host:port/<id>  the bridge's OCPP URL; the last part is the charger id
//   --protocol 2.0.1 | 1.6     OCPP version (default 2.0.1)
//   --phases 1 | 3             (default 1)
//   --voltage 230              per phase (default 230)
//   --amps-only                reject caps in W, like many real chargers
//   --max-w 7400               what the car draws with no cap (default 7400)
//   --min-amps 6               car stops below this per phase (default 0: never stops)
//   --password <password>      OCPP Security Profile 1 password (HTTP Basic auth).
//                              Visible in your shell history and process list:
//                              fine for a test password, not a real one.
//   --no-reconnect             stay offline (no exit) if the bridge goes away
//                              (default: reconnect with backoff, 1 s up to 10 s)
//
// It waits for the bridge if it isn't up yet. Ctrl+C stops it. If the bridge
// refuses it at the first connect (wrong/missing password: 401, unknown id:
// 404) it says why and exits. If the bridge restarts later, the sim keeps its
// caps and reconnects by itself, so you can restart `npm start` freely.

import { parseArgs } from 'node:util';
import { SimCharger } from './chargerSim.js';
import { createLogger } from './log.js';

const RETRY_MS = 2000;
const STATUS_EVERY_MS = 5000;

const { values } = parseArgs({
    options: {
        url: { type: 'string' },
        protocol: { type: 'string', default: '2.0.1' },
        phases: { type: 'string', default: '1' },
        voltage: { type: 'string', default: '230' },
        'amps-only': { type: 'boolean', default: false },
        'max-w': { type: 'string', default: '7400' },
        'min-amps': { type: 'string', default: '0' },
        password: { type: 'string' },
        'no-reconnect': { type: 'boolean', default: false },
    },
});

function fail(msg: string): never {
    console.error(`charger-sim: ${msg}\nusage: npm run charger-sim -- --url ws://localhost:9030/CP1 [--protocol 1.6] [--phases 3] [--amps-only] [--password <pw>]`);
    process.exit(2);
}

// ws://localhost:9030/CP1 -> endpoint ws://localhost:9030, id CP1 (the OCPP
// library adds the id back onto the URL when it connects).
if (!values.url) fail('--url is required');
const match = /^(wss?:\/\/.+)\/([^/]+)$/.exec(values.url);
if (!match) fail(`--url must look like ws://host:port/<charger id>, got ${values.url}`);
const [, endpoint, id] = match;

const protocol = values.protocol;
if (protocol !== '2.0.1' && protocol !== '1.6') fail(`--protocol must be 2.0.1 or 1.6, got ${protocol}`);
const phases = Number(values.phases);
if (phases !== 1 && phases !== 3) fail(`--phases must be 1 or 3, got ${values.phases}`);
const number = (name: string, v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a number >= 0, got ${v}`);
    return n;
};

const log = createLogger(id);
const sim = new SimCharger({
    id: decodeURIComponent(id),
    endpoint,
    protocol,
    phases,
    voltage: number('voltage', values.voltage),
    acceptsW: !values['amps-only'],
    evMaxW: number('max-w', values['max-w']),
    evMinAmpsPerPhase: number('min-amps', values['min-amps']),
    password: values.password,
    autoReconnect: !values['no-reconnect'],
    log: (m) => log.info(m),
});

const details = [`OCPP ${protocol}`, `${phases}-phase`, values['amps-only'] && 'amps only', values.password !== undefined && 'with password'];
log.info(`connecting to ${values.url} (${details.filter(Boolean).join(', ')})`);
for (;;) {
    try {
        await sim.start();
        break;
    } catch (err) {
        const e = err as Error & { code?: string | number };
        // Refusals won't fix themselves by retrying, unlike a bridge that isn't up yet.
        if (e.code === 401) fail(`the bridge refused ${id}: ${values.password === undefined ? 'it needs a password (--password)' : 'wrong password'}`);
        if (e.code === 404) fail(`the bridge refused ${id}: it isn't a configured charger (ids are case-sensitive)`);
        log.warn(`can't connect (${e.message || e.code || String(err)}), retrying in ${RETRY_MS / 1000} s`);
        await new Promise((r) => setTimeout(r, RETRY_MS));
    }
}

// What a person watching wants to see: the power, not every meter message.
let lastW: number | undefined;
let lastPrintAt = 0;
setInterval(() => {
    const w = sim.currentPowerW();
    if (w !== lastW || Date.now() - lastPrintAt >= STATUS_EVERY_MS) {
        log.info(`drawing ${w} W`);
        lastW = w;
        lastPrintAt = Date.now();
    }
}, 1000);

let stopping = false;
const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    await sim.stop().catch(() => {});
    process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
