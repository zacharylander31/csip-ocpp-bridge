// Structured logging for the bridge: one line per event, with a timestamp,
// level and component.
//
//   text: 2026-10-23T05:12:00.123Z INFO  [bridge] site limit 3000 W ...
//   json: {"time":"2026-10-23T05:12:00.123Z","level":"info","component":"bridge","msg":"site limit 3000 W ..."}
//
// Text is for people reading `docker compose logs`; JSON is for log
// collectors. No dependencies: the bridge logs a few lines a minute, so a
// logging library would add more than it saves.
//
// Repeated warnings and errors are folded: the same one from the same
// component within REPEAT_WINDOW_MS is printed once, then once more per
// window with a count. Without this an offline charger writes "couldn't
// update CP1" every second for as long as it's offline. Info lines are never
// folded: they report changes ("site limit 5000 W"), and the same change
// coming back a minute later is news.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REPEAT_WINDOW_MS = 60_000;
const MAX_TRACKED_MESSAGES = 500; // keeps the repeat map from growing forever

let minLevel: LogLevel = 'info';
let format: LogFormat = 'text';
// For tests: where lines go. stderr for warn/error, stdout otherwise.
let write = (level: LogLevel, line: string): void => {
    (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(line + '\n');
};

export function configureLogging(opts: { level?: LogLevel; format?: LogFormat }): void {
    if (opts.level) minLevel = opts.level;
    if (opts.format) format = opts.format;
}

export function isLogLevel(s: unknown): s is LogLevel {
    return typeof s === 'string' && s in LEVELS;
}

// message key -> when it was last printed, and how many times it's been held back since
const recent = new Map<string, { printedAt: number; held: number }>();

function emit(level: LogLevel, component: string, msg: string): void {
    if (LEVELS[level] < LEVELS[minLevel]) return;

    const now = Date.now();
    if (LEVELS[level] < LEVELS.warn) return print(level, component, msg, now);

    const key = `${level}|${component}|${msg}`;
    const seen = recent.get(key);
    if (seen && now - seen.printedAt < REPEAT_WINDOW_MS) {
        seen.held++;
        return;
    }
    if (seen && seen.held > 0) msg += ` (repeated ${seen.held} more times in the last ${Math.round((now - seen.printedAt) / 1000)} s)`;
    if (recent.size >= MAX_TRACKED_MESSAGES) recent.clear();
    recent.set(key, { printedAt: now, held: 0 });
    print(level, component, msg, now);
}

function print(level: LogLevel, component: string, msg: string, now: number): void {
    const time = new Date(now).toISOString();
    write(
        level,
        format === 'json'
            ? JSON.stringify({ time, level, component, msg })
            : `${time} ${level.toUpperCase().padEnd(5)} [${component}] ${msg}`,
    );
}

export interface Logger {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}

export function createLogger(component: string): Logger {
    return {
        debug: (m) => emit('debug', component, m),
        info: (m) => emit('info', component, m),
        warn: (m) => emit('warn', component, m),
        error: (m) => emit('error', component, m),
    };
}

/**
 * The other modules (Bridge, Manager, OdeMqttSource) take a plain
 * `(msg) => void`. This adapts a component logger to that, guessing the level
 * from the words in the message: failures and comms loss are warnings,
 * everything else is info. A guess, but the messages are ours and few, so
 * it's right for all of them today.
 */
export function logFn(component: string): (msg: string) => void {
    const log = createLogger(component);
    return (msg) => (WARN_WORDS.test(msg) ? log.warn(msg) : log.info(msg));
}

const WARN_WORDS = /fail|error|couldn't|COMMS LOST|lost|offline|Rejected|said (?!Accepted)|dropped|bad message|invalid|SILENT/i;

/** For tests: capture lines instead of printing them, and forget repeats. */
export function captureLogs(sink: (level: LogLevel, line: string) => void): void {
    write = sink;
    recent.clear();
}
