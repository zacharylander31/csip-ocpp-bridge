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
const meter = { type: 'ode-rest', url: 'http://open-dynamic-export:3000' };
const minimal = { limitSource: odeSource, siteMeter: meter, chargers: [{ id: 'CP1' }] };

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

// -- site meter --
const meterOf = (m: object) => parseConfig({ ...minimal, siteMeter: { ...meter, ...m } }, 'test', {}).siteMeter;
const meterDefaults = meterOf({});
check(meterDefaults?.pollMs === 1000 && meterDefaults.silentAfterMs === 15_000 && meterDefaults.chargerIdleAfterMs === 15_000, 'site meter defaults: poll 1 s, silent 15 s, charger idle 15 s');
check(meterOf({ url: 'http://localhost:3000/' })?.url === 'http://localhost:3000/', 'site meter URL with a trailing slash accepted');
check(example.siteMeter?.type === 'ode-rest', 'example: site meter from ODE');
const noMeter = parseConfig({ limitSource: odeSource, chargers: [{ id: 'CP1' }] }, 'test', {});
check(noMeter.siteMeter === undefined && noMeter.warnings.some((w) => w.includes('siteMeter is not set')), 'ode-mqtt without a site meter warns');
check(!csip.warnings.some((w) => w.includes('siteMeter')), 'csip (mock server) without a site meter: no warning');
const meterError = (m: object, fragment: string) => hasError({ ...minimal, siteMeter: { ...meter, ...m } }, fragment);
check(meterError({ type: 'modbus' }, 'siteMeter.type must be "ode-rest"'), 'unknown site meter type rejected');
check(meterError({ url: 'open-dynamic-export:3000' }, "must be ODE's address"), 'site meter URL without http:// rejected');
check(meterError({ url: 'http://ode:3000/api/coordinator/status' }, "must be ODE's address"), 'site meter URL with a path rejected');
check(meterError({ pol: 1000 }, 'siteMeter.pol is not a known option'), 'site meter typo rejected');
check(meterError({ pollMs: 50 }, 'siteMeter.pollMs must be'), 'site meter poll of 50 ms rejected');
check(meterError({ pollMs: 5000, silentAfterMs: 5000 }, 'must be longer than siteMeter.pollMs'), 'silentAfterMs <= pollMs rejected');
check(hasError({ ...minimal, siteMeter: 'ode' }, 'siteMeter must be an object'), 'site meter that is not an object rejected');

// -- charger passwords (OCPP Security Profile 1) --
const GOOD_PW = 'Xq7-vT2_kL9pR4mZ'; // 16 characters
const pwOf = (raw: unknown, env: NodeJS.ProcessEnv) => parseConfig(raw, 'test', env);
const sp1 = pwOf({ ...minimal, chargers: [{ id: 'CP1', passwordEnv: 'CP1_PW' }] }, { CP1_PW: GOOD_PW });
check(sp1.chargers[0].password === GOOD_PW && sp1.chargers[0].passwordEnv === 'CP1_PW' && sp1.warnings.length === 0, 'charger password read from its passwordEnv');
check(errorsFor({ ...minimal, chargers: [{ id: 'CP1', password: GOOD_PW }] }).some((p) => p.includes('chargers[0].password must not be in the config file')), 'charger password in the file is rejected');
check(errorsFor({ ...minimal, chargers: [{ id: 'CP1', passwordEnv: 'CP1_PW' }] }).some((p) => p.includes('CP1_PW is not set')), 'passwordEnv naming an unset variable is an error');
check(errorsFor({ ...minimal, chargers: [{ id: 'CP1', passwordEnv: 'my-var' }] }).some((p) => p.includes('environment variable name')), 'passwordEnv that is not a variable name rejected');
check(errorsFor({ ...minimal, chargerDefaults: { passwordEnv: 'X' } }).some((p) => p.includes('passwords are per charger')), 'passwordEnv in chargerDefaults rejected');
const pwErrors = (pw: string) => errorsFor({ ...minimal, chargers: [{ id: 'CP1', passwordEnv: 'CP1_PW' }] }, { CP1_PW: pw });
const short = pwErrors('short-pw-123');
check(short.some((p) => p.includes('is 12 characters; OCPP needs 16 to 40')), 'password shorter than 16 rejected');
check(!short.some((p) => p.includes('short-pw-123')), 'password error does not repeat the password');
check(pwErrors('a'.repeat(41)).some((p) => p.includes('is 41 characters')), 'password longer than 40 rejected');
check(pwErrors(`${GOOD_PW}\n`).some((p) => p.includes('trailing newline')), 'password with a trailing newline rejected');
check(pwErrors('a'.repeat(40)).length === 0, '40-character password accepted');
const mixed = pwOf({ ...minimal, chargers: [{ id: 'CP1', passwordEnv: 'CP1_PW' }, { id: 'CP2' }] }, { CP1_PW: GOOD_PW });
check(mixed.warnings.some((w) => w.includes('CP2 have no passwordEnv')), 'warns about chargers without a password when others have one');
const shared = pwOf({ ...minimal, chargers: [{ id: 'CP1', passwordEnv: 'PW' }, { id: 'CP2', passwordEnv: 'PW' }] }, { PW: GOOD_PW });
check(shared.warnings.some((w) => w.includes('share one password')), 'warns when two chargers share a password');
const hex40 = pwOf({ ...minimal, chargers: [{ id: 'CP1', passwordEnv: 'PW' }] }, { PW: 'ab'.repeat(20) });
check(hex40.warnings.some((w) => w.includes('40 hex digits')), 'warns about a 40-hex-digit password (1.6 binary key confusion)');

try {
    loadConfig('does-not-exist.json', {});
    check(false, 'missing file rejected');
} catch (err) {
    check(err instanceof ConfigError && err.message.includes("can't read it"), 'missing file rejected with a clear error');
}

console.log(problems.length === 0 ? 'RESULT: PASS - config loader' : `RESULT: FAIL - ${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);
