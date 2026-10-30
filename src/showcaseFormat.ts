// How the showcase looks on screen. Shared by `npm run showcase` (terminal)
// and `npm run demo-animation` (the .cast and .svg in docs/), so the
// animation shows exactly what the terminal shows.

export type Who = 'NETWORK' | 'BRIDGE' | 'CHARGER';

// One thing the showcase printed. `at` is ms since the showcase started.
export type ShowcaseEvent =
    | { at: number; kind: 'line'; clock: string; who: Who; msg: string }
    | { at: number; kind: 'text'; text: string; style?: 'dim' | 'pass' | 'fail' }
    | { at: number; kind: 'power'; chargerId: string; watts: number; limitW?: number }
    // The live power bar stops being redrawn and stays where it is.
    | { at: number; kind: 'barDone' };

export const MAX_W = 7400; // the simulated car's maximum, the bar's full scale
export const BAR_CELLS = 30;

// ANSI colour codes, also used to pick SVG colours.
export const COLOUR: Record<Who | 'dim' | 'pass' | 'fail', number> = {
    NETWORK: 36, // cyan
    BRIDGE: 33, // yellow
    CHARGER: 32, // green
    dim: 90,
    pass: 32,
    fail: 31,
};

const paint = (code: number, s: string, colour: boolean) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);

/** `14:02:01  NETWORK  default limit for this site: 5 kW` */
export function lineParts(e: Extract<ShowcaseEvent, { kind: 'line' }>): { clock: string; who: string; msg: string } {
    return { clock: `${e.clock}  `, who: e.who.padEnd(9), msg: e.msg };
}

export function formatEvent(e: ShowcaseEvent, colour: boolean): string {
    if (e.kind === 'line') {
        const p = lineParts(e);
        return paint(COLOUR.dim, p.clock, colour) + paint(COLOUR[e.who], p.who, colour) + p.msg;
    }
    if (e.kind === 'text') return e.style ? paint(COLOUR[e.style], e.text, colour) : e.text;
    if (e.kind === 'barDone') return '';
    const filled = barCells(e.watts);
    const bar = paint(COLOUR.CHARGER, '█'.repeat(filled), colour) + paint(COLOUR.dim, '░'.repeat(BAR_CELLS - filled), colour);
    return `${powerLabel(e).left}${bar}${powerLabel(e).right}`;
}

export function barCells(watts: number): number {
    return Math.max(0, Math.min(BAR_CELLS, Math.round((watts / MAX_W) * BAR_CELLS)));
}

/** The text either side of the bar: `CP1 drawing  [bar]  3000 W  (network limit 3 kW)` */
export function powerLabel(e: Extract<ShowcaseEvent, { kind: 'power' }>): { left: string; right: string } {
    const limit = e.limitW === undefined ? '' : `   network limit ${kW(e.limitW)}`;
    return { left: `          ${e.chargerId} drawing  `, right: `  ${String(e.watts).padStart(4)} W${limit}` };
}

export const kW = (w: number) => `${Number((w / 1000).toFixed(1))} kW`;
