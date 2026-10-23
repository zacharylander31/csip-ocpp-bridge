// `npm run config-test`: the config loader accepts both example files and
// rejects bad configs with clear messages. No network, runs in under a second.

import { loadConfig, parseConfig, stripJsonComments, ConfigError, MQTT_PASSWORD_ENV } from './config.js';

const problems: string[] = [];
const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) problems.push(what);
};

// Errors from parseConfig, or [] if it was accepted.
function errorsFor(raw: unknown, env: NodeJS.ProcessEnv = {}): string[] {
    try {
        parseConfig(raw, 'test', env);
        return [];
    } catch (err) {
        if (err instanceof ConfigError) return err.problems;
        throw err;
    }
}
const hasError = (raw: unknown, fragment: string) => errorsFor(raw).some((p) => p.includes(fragment));

const odeSource = { type: 'ode-mqtt', url: 'mqtt://mosquitto:1883', topic: 'limits', fallbackImportLimitW: 1500 };
const minimal = { limitSource: odeSource, chargers: [{ id: 'CP1' }] };

// -- comment stripping --
check(stripJsonComments('{"a": "mqtt://x" // c\n}') === '{"a": "mqtt://x"     \n}', '// comment stripped, // inside a string kept');
check(stripJsonComments('{/* a\nb */"a": "\\"/*"}') === '{    \n    "a": "\\"/*"}', '/* */ stripped keeping newlines; escaped quote in string handled');

// -- the shipped examples --
for (const file of ['config.example.json', 'config.example.mock-csip.json']) {
    try {
        const cfg = loadConfig(file, {});
        check(cfg.chargers.length === 1 && cfg.chargers[0].id === 'CP1', `${file} loads`);
    } catch (err) {
        check(false, `${file} loads: ${(err as Error).message}`);
    }
}
const example = loadConfig('config.example.json', {});
check(example.warnings.length === 0, 'config.example.json gives no warnings');
check(example.limitSource.type === 'ode-mqtt' && example.limitSource.fallbackImportLimitW === 1500, 'example: ode-mqtt with fallback 1500 W');
check(example.chargers[0].config.minAmpsPerPhase === 6 && example.chargers[0].config.rateUnit === 'W', 'example: charger defaults applied');

// -- good configs --
check(errorsFor(minimal).length === 0, 'minimal ODE config accepted');
const full = parseConfig({
    limitSource: odeSource,
    chargerDefaults: { phases: 3 },
    chargers: [{ id: 'CP1' }, { id: 'CP2', phases: 1, rateUnit: 'A', voltage: 240 }],
}, 'test', {});
check(full.chargers[0].config.phases === 3 && full.chargers[1].config.phases === 1, 'per-charger settings override chargerDefaults');
check(full.ocpp.port === 9000 && full.bridge.pollMs === 1000 && full.log.level === 'info', 'defaults: port 9000, ODE poll 1 s, log info');
const withPassword = parseConfig({ ...minimal, limitSource: { ...odeSource, username: 'u' } }, 'test', { [MQTT_PASSWORD_ENV]: 's3cret' });
check(withPassword.limitSource.type === 'ode-mqtt' && withPassword.limitSource.password === 's3cret', `password read from ${MQTT_PASSWORD_ENV}`);
const csip = parseConfig({ limitSource: { type: 'csip', url: 'http://localhost:8080' }, chargers: [{ id: 'CP1' }] }, 'test', {});
check(csip.bridge.pollMs === 60_000, 'csip: default poll 60 s');

// -- warnings --
const noFallback = parseConfig({ ...minimal, limitSource: { ...odeSource, fallbackImportLimitW: undefined } }, 'test', {});
check(noFallback.warnings.some((w) => w.includes('fallbackImportLimitW')), 'warns when fallbackImportLimitW is missing');
const ampsDefault = parseConfig({ ...minimal, chargers: [{ id: 'CP1', rateUnit: 'A' }] }, 'test', {});
check(ampsDefault.chargers[0].config.maxVoltage === 253 && ampsDefault.warnings.length === 0, 'amps charger: maxVoltage defaults to 253 V, no warning');
const ampsLowV = parseConfig({ ...minimal, chargers: [{ id: 'CP1', rateUnit: 'A', maxVoltage: 240 }] }, 'test', {});
check(ampsLowV.warnings.some((w) => w.includes('253 V')), 'warns about amps chargers with maxVoltage below 253 V');

// -- bad configs --
check(hasError({ ...minimal, limitSource: { ...odeSource, password: 'x' } }, MQTT_PASSWORD_ENV), 'password in the file is rejected');
check(hasError({ ...minimal, chargers: [{ id: 'CP1', phase: 3 }] }, 'chargers[0].phase is not a known option'), 'typo "phase" rejected');
check(hasError({ ...minimal, chargers: [{ id: 'CP1', phases: 2 }] }, 'chargers[0].phases must be one of 1, 3'), 'phases 2 rejected');
check(hasError({ ...minimal, chargers: [{ id: 'CP1' }, { id: 'CP1' }] }, 'used twice'), 'duplicate charger id rejected');
check(hasError({ ...minimal, chargers: [{ id: 'my charger' }] }, 'chargers[0].id must be'), 'charger id with a space rejected');
check(hasError({ ...minimal, chargers: [] }, 'at least one charger'), 'empty charger list rejected');
check(hasError({ ...minimal, chargers: [{ id: 'CP1', voltage: 2300 }] }, 'voltage must be'), 'voltage 2300 rejected');
check(hasError({ ...minimal, chargers: [{ id: 'CP1', voltage: 240, maxVoltage: 235 }] }, 'must be at least voltage'), 'maxVoltage below voltage rejected');
check(hasError({ ...minimal, limitSource: { ...odeSource, type: 'mqtt' } }, 'limitSource.type must be'), 'unknown source type rejected');
check(hasError({ ...minimal, limitSource: { ...odeSource, url: 'localhost:1883' } }, 'broker URL'), 'broker URL without mqtt:// rejected');
check(hasError({ ...minimal, ocpp: { port: 70000 } }, 'ocpp.port'), 'port 70000 rejected');
check(hasError({ ...minimal, log: { level: 'verbose' } }, 'log.level'), 'unknown log level rejected');
check(hasError({ ...minimal, bridge: { commsLostAfterMs: 5000 } }, 'set limitSource.commsLostAfterMs instead'), 'bridge.commsLostAfterMs with ODE rejected');
check(
    hasError({ limitSource: { type: 'csip', url: 'http://localhost:8080' }, chargers: [{ id: 'CP1' }], bridge: { pollMs: 5000, commsLostAfterMs: 5000 } }, 'must be longer than bridge.pollMs'),
    'commsLostAfterMs <= pollMs rejected',
);
const many = errorsFor({ limitSource: { type: 'csip' }, chargers: [{ phases: 2 }], ocpp: { port: 'x' } });
check(many.length >= 4, `all problems reported at once (${many.length}): ${many.join(' | ')}`);
try {
    loadConfig('does-not-exist.json', {});
    check(false, 'missing file rejected');
} catch (err) {
    check(err instanceof ConfigError && err.message.includes("can't read it"), 'missing file rejected with a clear error');
}

console.log(problems.length === 0 ? 'RESULT: PASS - config loader' : `RESULT: FAIL - ${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);
