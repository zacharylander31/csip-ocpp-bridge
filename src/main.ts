// `npm start`: run the bridge from a config file.
//
//   npm start                                   reads ./config.json
//   npm start -- --config path/to/config.json   or set BRIDGE_CONFIG
//   npm start -- --check                        validate the config and exit
//
// Starts, in order: the OCPP server (so chargers can connect straight away),
// the limit source (ODE over MQTT, or the built-in CSIP-AUS client), then the
// bridge's loops.
//
// Shutdown (Ctrl+C, `docker compose stop`, SIGTERM): stop the bridge, the
// limit source and the OCPP server, and exit. The chargers KEEP THEIR LAST
// CAP. That's deliberate: removing caps on the way out would let every
// charger draw full power while nothing is enforcing the network's limit,
// which is exactly what the limit is there to prevent. When the bridge comes
// back, it sends every charger its current share on the first tick. The
// cost: if the bridge never comes back, a charger stays at its last cap
// until it's pointed at another CSMS or reboots (see docs/install.md).
//
// Exit codes: 0 clean shutdown, 1 crashed or shutdown timed out, 2 bad config.

import { parseArgs } from 'node:util';
import { Bridge } from './bridge.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { CsipClient } from './csipClient.js';
import { ManagedCharger, Manager } from './csms.js';
import type { LimitSource } from './limitSource.js';
import { configureLogging, createLogger, logFn } from './log.js';
import { OdeMqttSource } from './odeMqttSource.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;
const UNKNOWN_CHARGER_CHECK_MS = 10_000;

const log = createLogger('main');

const { values: args } = parseArgs({
    options: {
        config: { type: 'string', short: 'c' },
        check: { type: 'boolean' },
    },
});
const configFile = args.config ?? process.env.BRIDGE_CONFIG ?? 'config.json';

let config: Config;
try {
    config = loadConfig(configFile);
} catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // One line per problem, so each keeps its timestamp in a log collector.
    log.error(`${err.file} is not valid, not starting:`);
    for (const p of err.problems) log.error(`  - ${p}`);
    process.exit(2);
}
configureLogging(config.log);
for (const w of config.warnings) log.warn(w);
if (args.check) {
    log.info(`${configFile} is valid`);
    process.exit(0);
}

// ---- start ----

log.info(
    `starting: limits from ${config.limitSource.type} (${config.limitSource.url}), ` +
        `${config.chargers.length} charger(s): ${config.chargers.map((c) => describeCharger(c)).join('; ')}`,
);

const ocppLog = logFn('ocpp');
const manager = new Manager(ocppLog, {
    chargers: Object.fromEntries(config.chargers.map((c) => [c.id, c.config])),
    bootWaitMs: config.ocpp.bootWaitMs,
});
// Create the configured chargers now, before they connect, so the bridge can
// own them from the start. Manager reuses an existing entry when that id
// connects (that's how it handles reconnects), so these get attached then.
// Until then they're offline: the bridge's sends fail and are retried, and
// the charger gets its share as soon as it connects.
const chargers = config.chargers.map((c) => {
    const charger = new ManagedCharger(c.id, c.config, ocppLog);
    manager.chargers.set(c.id, charger);
    return charger;
});

const source = makeSource(config);
const bridge = new Bridge(source, chargers, {
    pollMs: config.bridge.pollMs,
    tickMs: config.bridge.tickMs,
    // For ODE, leaving this unset lets the source's own limitSource.commsLostAfterMs apply.
    commsLostAfterMs: config.bridge.commsLostAfterMs,
    log: logFn('bridge'),
});

await manager.listen(config.ocpp.port);
log.info(`chargers connect to ws://<this machine>:${config.ocpp.port}/<id>, e.g. ws://localhost:${config.ocpp.port}/${chargers[0].id}`);
if (source instanceof OdeMqttSource) source.start();
await bridge.start();
log.info('running');

// Manager accepts any charger id. One that isn't in the config is never
// capped, so it can push the site over the network's limit: say so loudly.
const warnedUnknown = new Set<string>();
const unknownCheck = setInterval(() => {
    for (const [id, charger] of manager.chargers) {
        if (charger.connected && !config.chargers.some((c) => c.id === id) && !warnedUnknown.has(id)) {
            warnedUnknown.add(id);
            log.warn(`charger "${id}" connected but is not in ${configFile}: it is NOT being capped. Add it to "chargers" and restart.`);
        }
    }
}, UNKNOWN_CHARGER_CHECK_MS);

// ---- shutdown ----

let stopping = false;
async function shutdown(signal: string): Promise<void> {
    if (stopping) {
        log.warn(`${signal} again, exiting now`);
        process.exit(1);
    }
    stopping = true;
    log.info(`${signal}: shutting down, leaving the chargers' last caps in place`);
    const timeout = setTimeout(() => {
        log.error(`shutdown took over ${SHUTDOWN_TIMEOUT_MS / 1000} s, exiting anyway`);
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timeout.unref();

    clearInterval(unknownCheck);
    await bridge.stop(); // no new caps are sent after this; any in flight finish
    if (source instanceof OdeMqttSource) await source.stop();
    await manager.close();
    log.info('stopped');
    process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// For runtime-demo on Windows, which can't send signals: a parent process
// started with an IPC channel can send 'shutdown' to run the same path.
process.on('message', (m) => m === 'shutdown' && void shutdown('shutdown message'));

// A bug we didn't catch: log it and exit, so Docker's restart policy brings
// us back with a clean state, rather than limping on.
process.on('unhandledRejection', (err) => {
    log.error(`unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
});

// ---- helpers ----

function makeSource(cfg: Config): LimitSource {
    const s = cfg.limitSource;
    if (s.type === 'csip') return new CsipClient(s.url, { pen: s.pen });
    return new OdeMqttSource({
        url: s.url,
        topic: s.topic,
        csipAusTopic: s.csipAusTopic,
        username: s.username,
        password: s.password,
        commsLostAfterMs: s.commsLostAfterMs,
        fallbackImportLimitW: s.fallbackImportLimitW,
        log: logFn('ode-mqtt'),
    });
}

function describeCharger(c: Config['chargers'][number]): string {
    const { rateUnit, phases, voltage, minAmpsPerPhase } = c.config;
    return `${c.id} (${rateUnit}, ${phases}-phase, ${voltage} V, min ${minAmpsPerPhase} A)`;
}
