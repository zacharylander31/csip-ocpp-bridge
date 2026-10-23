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
// BRIDGE_MQTT_PASSWORD environment variable.

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

export interface ChargerEntry {
    id: string;
    config: ChargerConfig; // defaults + chargerDefaults + this charger's own settings
}

export interface Config {
    limitSource: LimitSourceConfig;
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

/** Check an already-parsed config object. Throws ConfigError listing every problem. */
export function parseConfig(raw: unknown, file = 'config', env: NodeJS.ProcessEnv = process.env): Config {
    const c = new Checker();
    const warnings: string[] = [];
    const root = c.object(raw, '', ['$schema', 'limitSource', 'ocpp', 'chargerDefaults', 'chargers', 'bridge', 'log']) ?? {};

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

    // -- OCPP --
    const ocppRaw = root.ocpp === undefined ? {} : c.object(root.ocpp, 'ocpp', ['port', 'bootWaitMs']) ?? {};
    const ocpp = {
        port: c.number(ocppRaw, 'ocpp', 'port', { min: 1, max: 65535, integer: true }) ?? 9000,
        bootWaitMs: c.number(ocppRaw, 'ocpp', 'bootWaitMs', { min: 0, max: 60_000, integer: true }),
    };

    // -- chargers --
    const defaultsRaw = root.chargerDefaults === undefined ? {} : c.object(root.chargerDefaults, 'chargerDefaults', [...CHARGER_KEYS]) ?? {};
    const defaults = chargerSettings(c, defaultsRaw, 'chargerDefaults');
    const chargers: ChargerEntry[] = [];
    if (!Array.isArray(root.chargers) || root.chargers.length === 0) {
        c.problems.push('chargers must be a list with at least one charger, e.g. [{ "id": "CP1" }]');
    } else {
        const seen = new Set<string>();
        root.chargers.forEach((entry, i) => {
            const p = `chargers[${i}]`;
            const o = c.object(entry, p, ['id', ...CHARGER_KEYS]);
            if (!o) return;
            const id = c.string(o, p, 'id', true, CHARGER_ID, 'must be 1-48 letters, digits or ._~:@|*+- (it goes in the charger\'s OCPP URL)');
            if (id && seen.has(id)) c.problems.push(`${p}.id "${id}" is used twice`);
            seen.add(id);
            chargers.push({ id, config: { ...DEFAULT_CHARGER_CONFIG, ...defaults, ...chargerSettings(c, o, p) } });
        });
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
        ocpp,
        chargers,
        bridge: { ...bridge, pollMs },
        log: { level: level!, format },
        warnings,
    };
}
