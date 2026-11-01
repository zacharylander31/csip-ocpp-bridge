// The bridge's one config file: load it, check it, and turn it into the
// options the other modules take.
//
// Format: JSON, with // and /* */ comments allowed (like VS Code's settings).
// Why JSON and not YAML:
//  - Open Dynamic Export's config is JSON (config/config.json), and an
//    installer setting up this bridge has just edited that one. One format.
//  - No parser dependency: YAML needs one (and YAML has surprises like
//    `no` meaning false and `08` not being a number).
//  - Comments are what plain JSON lacks for an example file, so we strip
//    them before JSON.parse. They're replaced with spaces, so JSON.parse's
//    error positions still point at the right line.
//
// Validation is strict on purpose: unknown keys are errors (so a typo like
// "phase" instead of "phases" can't silently fall back to a default), and
// every problem is reported at once, with its path, before anything starts.
//
// Secrets never come from the file: the MQTT password is read from the
// BRIDGE_MQTT_PASSWORD environment variable, and each charger's OCPP password
// from the environment variable its `passwordEnv` names. Config files get
// copied, pasted into bug reports and committed to git; environment variables
// (from Docker's .env file) stay on the box.

import { readFileSync } from 'node:fs';
import { DEFAULT_CHARGER_CONFIG, type ChargerConfig } from './csms.js';
import { isLogLevel, type LogFormat, type LogLevel } from './log.js';

export const MQTT_PASSWORD_ENV = 'BRIDGE_MQTT_PASSWORD';

export type LimitSourceConfig =
    | {
          type: 'ode-mqtt';
          url: string;
          topic: string;
          csipAusTopic?: string;
          username?: string;
          password?: string; // from the environment, never the file
          commsLostAfterMs?: number;
          fallbackImportLimitW?: number;
      }
    | {
          type: 'csip';
          url: string; // base URL; the client starts at <url>/dcap
          pen?: string;
      };

export interface SiteMeterConfig {
    type: 'ode-rest';
    url: string; // ODE's address; the bridge reads <url>/api/coordinator/status
    pollMs: number;
    silentAfterMs: number; // no new reading for this long -> chargers get 0 W
    chargerIdleAfterMs: number; // a charger silent this long counts as 0 W in the house load
}

export interface ChargerEntry {
    id: string;
    config: ChargerConfig; // defaults + chargerDefaults + this charger's own settings
    /** OCPP Security Profile 1 password, from the environment variable `passwordEnv` names. Never log it. */
    password?: string;
    passwordEnv?: string;
}

export interface Config {
    limitSource: LimitSourceConfig;
    siteMeter?: SiteMeterConfig;
    ocpp: { port: number; bootWaitMs?: number };
    chargers: ChargerEntry[];
    bridge: { pollMs?: number; tickMs?: number; commsLostAfterMs?: number };
    log: { level: LogLevel; format: LogFormat };
    /** Not errors, but worth saying at start-up (e.g. no fallback limit set). */
    warnings: string[];
}

export class ConfigError extends Error {
    constructor(
        readonly file: string,
        readonly problems: string[],
    ) {
        super(`${file} is not valid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    }
}

export function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env): Config {
    let text: string;
    try {
        text = readFileSync(file, 'utf8');
    } catch (err) {
        throw new ConfigError(file, [`can't read it: ${(err as Error).message}`]);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(stripJsonComments(text));
    } catch (err) {
        throw new ConfigError(file, [`not valid JSON: ${(err as Error).message}`]);
    }
    return parseConfig(raw, file, env);
}

/**
 * Remove // and /* *\/ comments, leaving strings alone (a URL like
 * "mqtt://host" contains // but isn't a comment). Each comment character
 * becomes a space and newlines are kept, so line and column numbers match.
 */
export function stripJsonComments(text: string): string {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            // Copy the whole string, including escaped quotes.
            const start = i++;
            while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
            out += text.slice(start, ++i);
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') (out += ' '), i++;
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end === -1 ? text.length : end + 2; // unclosed: JSON.parse will complain about what's left
            for (; i < stop; i++) out += text[i] === '\n' ? '\n' : ' ';
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

// ---- validation ----

// Collects problems as it goes, so the user sees all of them at once.
class Checker {
    problems: string[] = [];

    object(v: unknown, path: string, allowed: string[]): Record<string, unknown> | undefined {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
            this.problems.push(`${path} must be an object`);
            return undefined;
        }
        for (const key of Object.keys(v)) {
            if (!allowed.includes(key)) this.problems.push(`${join(path, key)} is not a known option (expected one of: ${allowed.join(', ')})`);
        }
        return v as Record<string, unknown>;
    }

    string(o: Record<string, unknown>, path: string, key: string, required: true, pattern?: RegExp, hint?: string): string;
    string(o: Record<string, unknown>, path: string, key: string, required: false, pattern?: RegExp, hint?: string): string | undefined;
    string(o: Record<string, unknown>, path: string, key: string, required: boolean, pattern?: RegExp, hint?: string): string | undefined {
        const v = o[key];
        const p = join(path, key);
        if (v === undefined) {
            if (required) this.problems.push(`${p} is required`);
            return required ? '' : undefined;
        }
        if (typeof v !== 'string' || v.trim() === '') {
            this.problems.push(`${p} must be a non-empty string, got ${show(v)}`);
            return '';
        }
        if (pattern && !pattern.test(v)) this.problems.push(`${p} ${hint ?? `must match ${pattern}`}, got ${show(v)}`);
        return v;
    }

    number(
        o: Record<string, unknown>,
        path: string,
        key: string,
        rule: { min?: number; max?: number; integer?: boolean; above?: number },
    ): number | undefined {
        const v = o[key];
        if (v === undefined) return undefined;
        const p = join(path, key);
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            this.problems.push(`${p} must be a number, got ${show(v)}`);
            return undefined;
        }
        const bad =
            (rule.integer && !Number.isInteger(v)) ||
            (rule.min !== undefined && v < rule.min) ||
            (rule.max !== undefined && v > rule.max) ||
            (rule.above !== undefined && v <= rule.above);
        if (bad) {
            const parts = [
                rule.integer ? 'a whole number' : 'a number',
                rule.above !== undefined ? `above ${rule.above}` : undefined,
                rule.min !== undefined ? `>= ${rule.min}` : undefined,
                rule.max !== undefined ? `<= ${rule.max}` : undefined,
            ].filter(Boolean);
            this.problems.push(`${p} must be ${parts.join(' ')}, got ${v}`);
            return undefined;
        }
        return v;
    }

    oneOf<T extends string | number>(o: Record<string, unknown>, path: string, key: string, options: readonly T[]): T | undefined {
        const v = o[key];
        if (v === undefined) return undefined;
        if (!options.includes(v as T)) {
            this.problems.push(`${join(path, key)} must be one of ${options.map((x) => JSON.stringify(x)).join(', ')}, got ${show(v)}`);
            return undefined;
        }
        return v as T;
    }
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);
const show = (v: unknown) => JSON.stringify(v) ?? String(v);

// OCPP's charging station identity goes in the URL path (ws://host:port/<id>).
// 2.0.1 allows up to 48 characters; keep to ones that need no URL escaping.
const CHARGER_ID = /^[A-Za-z0-9._~:@|*+-]{1,48}$/;

const CHARGER_KEYS = ['rateUnit', 'phases', 'voltage', 'maxVoltage', 'ampStep', 'minAmpsPerPhase'] as const;

// An environment variable name, as shells and Docker's .env files accept it.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// OCPP passwords. 2.0.1 (Part 2, SecurityCtrlr.BasicAuthPassword) allows 16
// to 40 characters; the 1.6 security whitepaper's AuthorizationKey is also
// at least 16. See plans/notes/sp1-passwords.md for the references.
export const PASSWORD_MIN = 16;
export const PASSWORD_MAX = 40;
// Printable ASCII without spaces: HTTP Basic auth (RFC 7617) wants text, and
// a space or newline at the end is almost always a copy-paste accident.
const PASSWORD_CHARS = /^[\x21-\x7E]+$/;

/**
 * What's wrong with a password, without ever repeating it (error messages
 * end up in logs), or undefined if it's fine.
 */
export function passwordProblem(password: string): string | undefined {
    if (!PASSWORD_CHARS.test(password)) {
        return 'contains a space, newline or non-ASCII character (a trailing newline from copy-paste?); use letters, digits, - and _';
    }
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        return `is ${password.length} characters; OCPP needs ${PASSWORD_MIN} to ${PASSWORD_MAX}`;
    }
    return undefined;
}

function chargerSettings(c: Checker, o: Record<string, unknown>, path: string): Partial<ChargerConfig> {
    const out: Partial<ChargerConfig> = {};
    const rateUnit = c.oneOf(o, path, 'rateUnit', ['W', 'A'] as const);
    const phases = c.oneOf(o, path, 'phases', [1, 3] as const);
    // AS 60038: 230 V nominal, +10% / -6%. Anything far outside is a typo (e.g. 2300).
    const voltage = c.number(o, path, 'voltage', { min: 180, max: 260 });
    const maxVoltage = c.number(o, path, 'maxVoltage', { min: 180, max: 260 });
    const ampStep = c.number(o, path, 'ampStep', { above: 0, max: 10 });
    // 32 A is the most a single-phase AC charger takes; a minimum above it can never be met.
    const minAmpsPerPhase = c.number(o, path, 'minAmpsPerPhase', { min: 0, max: 32 });
    if (rateUnit !== undefined) out.rateUnit = rateUnit;
    if (phases !== undefined) out.phases = phases;
    if (voltage !== undefined) out.voltage = voltage;
    if (maxVoltage !== undefined) out.maxVoltage = maxVoltage;
    if (ampStep !== undefined) out.ampStep = ampStep;
    if (minAmpsPerPhase !== undefined) out.minAmpsPerPhase = minAmpsPerPhase;
    return out;
}

// Read and check one charger's password from the environment.
function chargerPassword(c: Checker, warnings: string[], path: string, id: string, name: string, env: NodeJS.ProcessEnv): string | undefined {
    const password = env[name];
    if (!password) {
        // An error, not a warning: starting anyway would lock the charger out.
        c.problems.push(`${path}.passwordEnv: environment variable ${name} is not set or is empty (set it, or remove passwordEnv to let ${id} connect without a password)`);
        return undefined;
    }
    const problem = passwordProblem(password);
    if (problem) {
        c.problems.push(`${path}: the password in ${name} ${problem}`);
        return undefined;
    }
    if (/^[0-9A-Fa-f]{40}$/.test(password)) {
        warnings.push(
            `charger ${id}: the password in ${name} is 40 hex digits. Some OCPP 1.6 chargers read that as a hex-encoded ` +
                `20-byte key and send the raw bytes instead, which won't match. Prefer letters and digits.`,
        );
    }
    return password;
}

/** Check an already-parsed config object. Throws ConfigError listing every problem. */
export function parseConfig(raw: unknown, file = 'config', env: NodeJS.ProcessEnv = process.env): Config {
    const c = new Checker();
    const warnings: string[] = [];
    const root = c.object(raw, '', ['$schema', 'limitSource', 'siteMeter', 'ocpp', 'chargerDefaults', 'chargers', 'bridge', 'log']) ?? {};

    // -- limit source --
    let limitSource: LimitSourceConfig | undefined;
    if (root.limitSource === undefined) c.problems.push('limitSource is required');
    else {
        const type = (root.limitSource as { type?: unknown } | null)?.type;
        if (type === 'ode-mqtt') {
            const p = 'limitSource';
            const o = c.object(root.limitSource, p, ['type', 'url', 'topic', 'csipAusTopic', 'username', 'password', 'commsLostAfterMs', 'fallbackImportLimitW']) ?? {};
            if (o.password !== undefined) {
                c.problems.push(`${p}.password must not be in the config file: set the ${MQTT_PASSWORD_ENV} environment variable instead`);
            }
            limitSource = {
                type,
                url: c.string(o, p, 'url', true, /^(mqtts?|wss?):\/\/[^/\s]+/, 'must be a broker URL like "mqtt://mosquitto:1883"'),
                topic: c.string(o, p, 'topic', true),
                csipAusTopic: c.string(o, p, 'csipAusTopic', false),
                username: c.string(o, p, 'username', false),
                password: env[MQTT_PASSWORD_ENV] || undefined,
                commsLostAfterMs: c.number(o, p, 'commsLostAfterMs', { min: 2000, integer: true }),
                fallbackImportLimitW: c.number(o, p, 'fallbackImportLimitW', { min: 0 }),
            };
            if (limitSource.fallbackImportLimitW === undefined && o.fallbackImportLimitW === undefined) {
                warnings.push(
                    'limitSource.fallbackImportLimitW is not set. If the bridge starts while a network control is active, ' +
                        "it hasn't seen the default yet, and if ODE then goes silent the chargers get no cap at all. " +
                        'Set it to the import limit in your connection agreement (or ODE\'s fixedDefault.importLimitWatts).',
                );
            }
            if (limitSource.username && !limitSource.password) {
                warnings.push(`limitSource.username is set but ${MQTT_PASSWORD_ENV} is empty; connecting without a password`);
            }
        } else if (type === 'csip') {
            const p = 'limitSource';
            const o = c.object(root.limitSource, p, ['type', 'url', 'pen']) ?? {};
            limitSource = {
                type,
                url: c.string(o, p, 'url', true, /^https?:\/\/[^/\s]+/, 'must be a server URL like "http://localhost:8080"'),
                pen: c.string(o, p, 'pen', false, /^[0-9A-F]{8}$/, 'must be 8 upper-case hex digits (see penHex() in mirrorXml.ts)'),
            };
            if (limitSource.url.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(limitSource.url + '/')) {
                warnings.push('limitSource.url is plain http to another host. The built-in CSIP-AUS client has no TLS or certificates; use it only with the mock server. Real sites use "ode-mqtt".');
            }
        } else {
            c.problems.push(`limitSource.type must be "ode-mqtt" (Open Dynamic Export over MQTT) or "csip" (built-in client, for the mock server), got ${show(type)}`);
        }
    }

    // -- site meter --
    let siteMeter: SiteMeterConfig | undefined;
    if (root.siteMeter !== undefined) {
        const p = 'siteMeter';
        const o = c.object(root.siteMeter, p, ['type', 'url', 'pollMs', 'silentAfterMs', 'chargerIdleAfterMs']) ?? {};
        if (o.type !== 'ode-rest') c.problems.push(`siteMeter.type must be "ode-rest" (Open Dynamic Export's REST API), got ${show(o.type)}`);
        const pollMs = c.number(o, p, 'pollMs', { min: 200, max: 10_000, integer: true }) ?? 1000;
        const silentAfterMs = c.number(o, p, 'silentAfterMs', { min: 2000, integer: true }) ?? 15_000;
        if (silentAfterMs <= pollMs) c.problems.push(`siteMeter.silentAfterMs (${silentAfterMs}) must be longer than siteMeter.pollMs (${pollMs}), or the meter always counts as silent`);
        siteMeter = {
            type: 'ode-rest',
            url: c.string(o, p, 'url', true, /^https?:\/\/[^/\s]+\/?$/, 'must be ODE\'s address like "http://open-dynamic-export:3000", with no path'),
            pollMs,
            silentAfterMs,
            chargerIdleAfterMs: c.number(o, p, 'chargerIdleAfterMs', { min: 1000, integer: true }) ?? 15_000,
        };
    } else if (limitSource?.type === 'ode-mqtt') {
        warnings.push(
            'siteMeter is not set, so the chargers share the WHOLE site limit with nothing left for the house: the site goes over ' +
                'the limit whenever the house draws. Fine only if the chargers are the only load. See docs/configuration.md.',
        );
    }

    // -- OCPP --
    const ocppRaw = root.ocpp === undefined ? {} : c.object(root.ocpp, 'ocpp', ['port', 'bootWaitMs']) ?? {};
    const ocpp = {
        port: c.number(ocppRaw, 'ocpp', 'port', { min: 1, max: 65535, integer: true }) ?? 9000,
        bootWaitMs: c.number(ocppRaw, 'ocpp', 'bootWaitMs', { min: 0, max: 60_000, integer: true }),
    };

    // -- chargers --
    const defaultsRaw = root.chargerDefaults === undefined ? {} : c.object(root.chargerDefaults, 'chargerDefaults', [...CHARGER_KEYS, 'passwordEnv']) ?? {};
    if (defaultsRaw.passwordEnv !== undefined) {
        c.problems.push('chargerDefaults.passwordEnv: passwords are per charger (with one shared password any charger can pose as another); set passwordEnv on each charger');
    }
    const defaults = chargerSettings(c, defaultsRaw, 'chargerDefaults');
    const chargers: ChargerEntry[] = [];
    if (!Array.isArray(root.chargers) || root.chargers.length === 0) {
        c.problems.push('chargers must be a list with at least one charger, e.g. [{ "id": "CP1" }]');
    } else {
        const seen = new Set<string>();
        root.chargers.forEach((entry, i) => {
            const p = `chargers[${i}]`;
            const o = c.object(entry, p, ['id', 'passwordEnv', 'password', ...CHARGER_KEYS]);
            if (!o) return;
            const id = c.string(o, p, 'id', true, CHARGER_ID, 'must be 1-48 letters, digits or ._~:@|*+- (it goes in the charger\'s OCPP URL)');
            if (id && seen.has(id)) c.problems.push(`${p}.id "${id}" is used twice`);
            seen.add(id);
            if (o.password !== undefined) {
                c.problems.push(`${p}.password must not be in the config file: put it in an environment variable (e.g. in .env) and name that variable in ${p}.passwordEnv`);
            }
            const passwordEnv = c.string(o, p, 'passwordEnv', false, ENV_NAME, 'must be an environment variable name like "BRIDGE_CP1_PASSWORD"');
            const password = passwordEnv && ENV_NAME.test(passwordEnv) ? chargerPassword(c, warnings, p, id, passwordEnv, env) : undefined;
            chargers.push({
                id,
                config: { ...DEFAULT_CHARGER_CONFIG, ...defaults, ...chargerSettings(c, o, p) },
                ...(passwordEnv && { passwordEnv }),
                ...(password && { password }),
            });
        });
    }
    const withPassword = chargers.filter((ch) => ch.passwordEnv);
    if (withPassword.length > 0) {
        const without = chargers.filter((ch) => !ch.passwordEnv).map((ch) => ch.id);
        if (without.length > 0) {
            warnings.push(
                `charger(s) ${without.join(', ')} have no passwordEnv: any device on the network that knows the id can connect as them. ` +
                    'Fine for a charger without OCPP password support (Security Profile 1); otherwise give each one a password.',
            );
        }
        const byEnv = new Map<string, string[]>();
        for (const ch of withPassword) byEnv.set(ch.passwordEnv!, [...(byEnv.get(ch.passwordEnv!) ?? []), ch.id]);
        for (const [name, ids] of byEnv) {
            if (ids.length > 1) warnings.push(`chargers ${ids.join(', ')} share one password (${name}): each can pose as the other. Give each its own.`);
        }
    }
    for (const { id, config } of chargers) {
        if (config.maxVoltage < config.voltage) {
            c.problems.push(`charger ${id}: maxVoltage (${config.maxVoltage}) must be at least voltage (${config.voltage})`);
        }
        if (config.rateUnit === 'A' && config.maxVoltage < 253) {
            // W is turned into A at maxVoltage, but the car draws amps x the real voltage.
            warnings.push(
                `charger ${id} takes amps and maxVoltage is ${config.maxVoltage} V. If the supply goes higher (it can legally reach 253 V), ` +
                    `the charger can draw more than its share. Leave maxVoltage at its default, 253 V (the AS 60038 maximum).`,
            );
        }
    }

    // -- bridge timings --
    const bridgeRaw = root.bridge === undefined ? {} : c.object(root.bridge, 'bridge', ['pollMs', 'tickMs', 'commsLostAfterMs']) ?? {};
    const bridge = {
        pollMs: c.number(bridgeRaw, 'bridge', 'pollMs', { min: 1000, integer: true }),
        tickMs: c.number(bridgeRaw, 'bridge', 'tickMs', { min: 100, max: 60_000, integer: true }),
        commsLostAfterMs: c.number(bridgeRaw, 'bridge', 'commsLostAfterMs', { min: 2000, integer: true }),
    };
    if (limitSource?.type === 'ode-mqtt' && bridge.commsLostAfterMs !== undefined) {
        c.problems.push('bridge.commsLostAfterMs: with "ode-mqtt", set limitSource.commsLostAfterMs instead (one setting, one place)');
    }
    // The bridge's default poll for CSIP-AUS is 60 s; with ODE it only checks messages are still arriving.
    const pollMs = bridge.pollMs ?? (limitSource?.type === 'ode-mqtt' ? 1000 : 60_000);
    if (bridge.commsLostAfterMs !== undefined && bridge.commsLostAfterMs <= pollMs) {
        c.problems.push(`bridge.commsLostAfterMs (${bridge.commsLostAfterMs}) must be longer than bridge.pollMs (${pollMs}), or every poll counts as comms lost`);
    }

    // -- logging --
    const logRaw = root.log === undefined ? {} : c.object(root.log, 'log', ['level', 'format']) ?? {};
    const level = logRaw.level === undefined ? 'info' : isLogLevel(logRaw.level) ? logRaw.level : undefined;
    if (level === undefined) c.problems.push(`log.level must be one of "debug", "info", "warn", "error", got ${show(logRaw.level)}`);
    const format = c.oneOf(logRaw, 'log', 'format', ['text', 'json'] as const) ?? 'text';

    if (c.problems.length > 0 || !limitSource) throw new ConfigError(file, c.problems);
    return {
        limitSource,
        siteMeter,
        ocpp,
        chargers,
        bridge: { ...bridge, pollMs },
        log: { level: level!, format },
        warnings,
    };
}
