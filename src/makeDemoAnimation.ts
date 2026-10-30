// `npm run demo-animation`: runs `npm run showcase` once for real, then turns
// what it showed into two files for the README:
//   docs/showcase.svg   animated SVG (plain CSS animation, no scripts), embedded in the README
//   docs/showcase.cast  asciinema v2 recording (`asciinema play docs/showcase.cast`)
//
// Both come from the same recorded run, so they show real output, not a
// mock-up. Quiet stretches (e.g. 30 s of the charger holding 3 kW) are cut to
// GAP_MAX_MS so the animation is ~25 s instead of ~60 s; the clock times on
// each line are the real ones, so the cut is visible. No dependencies.
//
// Only writes the files if the showcase passed.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BAR_CELLS, barCells, COLOUR, formatEvent, lineParts, powerLabel, type ShowcaseEvent } from './showcaseFormat.js';

const GAP_MAX_MS = 4000; // longest pause kept between two visible changes
const END_HOLD_MS = 6000; // the final screen stays this long before the loop restarts

// ---- 1. record a real run ----
const dir = mkdtempSync(join(tmpdir(), 'showcase-record-'));
const recordFile = join(dir, 'showcase.json');
console.log('recording a real run of the showcase (about a minute)...');
const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/runShowcase.ts', '--live', '--record', recordFile], { stdio: 'inherit' });
if (run.status !== 0) {
    console.error(`\nshowcase exited with ${run.status}: not writing the animation`);
    process.exit(1);
}
const { events: raw } = JSON.parse(readFileSync(recordFile, 'utf8')) as { events: ShowcaseEvent[] };
rmSync(dir, { recursive: true, force: true });

// ---- 2. shorten quiet stretches ----
let shift = 0;
const events = raw.map((e, i) => {
    const gap = i === 0 ? e.at : e.at - raw[i - 1].at;
    if (gap > GAP_MAX_MS) shift += gap - GAP_MAX_MS;
    return { ...e, at: e.at - shift };
});
const endMs = events.at(-1)!.at + END_HOLD_MS;

// ---- 3. replay as a terminal screen ----
// Rows of finished lines, plus the live power bar under the last one until
// 'barDone'. Each screen state lasts until the next event.
interface Row {
    from: number; // ms when it appears (it then stays to the end)
    e: ShowcaseEvent;
}
interface BarFrame {
    from: number;
    to: number;
    row: number;
    e: Extract<ShowcaseEvent, { kind: 'power' }>;
}
const rows: Row[] = [];
const bars: BarFrame[] = [];
let bar: BarFrame | undefined;
let barLive = true;
for (const e of events) {
    if (e.kind === 'barDone') {
        if (bar) {
            rows.push({ from: bar.from, e: bar.e }); // the bar becomes an ordinary row
            bar.to = bar.from; // and its frame is dropped
        }
        bar = undefined;
        barLive = false;
        continue;
    }
    if (e.kind === 'power' && barLive) {
        if (bar) bar.to = e.at;
        bar = { from: e.at, to: endMs, row: rows.length, e };
        bars.push(bar);
        continue;
    }
    rows.push({ from: e.at, e });
    if (bar) {
        // the bar moves down one row
        bar.to = e.at;
        bar = { ...bar, from: e.at, to: endMs, row: rows.length };
        bars.push(bar);
    }
}
const height = rows.length + (barLive ? 1 : 0);

// Wide enough for the longest line.
const COLS = Math.max(...rows.map((r) => formatEvent(r.e, false).length), ...bars.map((b) => formatEvent(b.e, false).length)) + 2;

// ---- 4a. asciinema v2 ----
const cast: string[] = [JSON.stringify({ version: 2, width: COLS, height: height + 1, title: 'csip-ocpp-bridge showcase' })];
let status = '';
let castBarLive = true;
for (const e of events) {
    let out: string;
    if (e.kind === 'barDone') {
        out = '\r\n';
        status = '';
        castBarLive = false;
    } else if (e.kind === 'power' && castBarLive) {
        status = formatEvent(e, true);
        out = `\r\x1b[K${status}`;
    } else {
        out = `\r\x1b[K${formatEvent(e, true)}\r\n${status}`;
    }
    cast.push(JSON.stringify([e.at / 1000, 'o', out]));
}
cast.push(JSON.stringify([endMs / 1000, 'o', '']));
writeFileSync('docs/showcase.cast', cast.join('\n') + '\n');

// ---- 4b. animated SVG ----
const FONT = 14;
const CW = FONT * 0.6; // monospace character width
const LH = FONT * 1.45;
const PAD = 16;
const TOP = 34; // room for the window bar
const W = Math.ceil(PAD * 2 + COLS * CW);
const H = Math.ceil(TOP + PAD + height * LH + PAD);
const fill: Record<number, string> = { 36: '#39c5cf', 33: '#e3b341', 32: '#3fb950', 90: '#8b949e', 31: '#f85149' };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (ms: number) => `${((ms / endMs) * 100).toFixed(3)}%`;

// One keyframe set per distinct (from, to): opacity 0 before, 1 during, 0 after.
const keyframes = new Map<string, string>(); // key -> CSS
const classes = new Map<string, string>(); // key -> class name
function anim(from: number, to: number): string {
    const key = `${from}-${to}`;
    if (!classes.has(key)) {
        const name = `k${classes.size}`;
        const end = to >= endMs ? '' : `${pct(to)}{opacity:0}`;
        classes.set(key, name);
        keyframes.set(key, `@keyframes ${name}{0%{opacity:0}${pct(from)}{opacity:1}${end}}.${name}{animation-name:${name}}`);
    }
    return classes.get(key)!;
}

const y = (row: number) => TOP + PAD + row * LH + FONT;
function rowSvg(e: ShowcaseEvent, row: number, cls: string): string {
    const yy = y(row).toFixed(1);
    const t = (x: number, s: string, colour?: number) =>
        // textLength pins each piece to its grid width, so columns line up
        // whichever monospace font the viewer's browser picks.
        // Colour goes in style="", not fill="": the stylesheet's text{fill} beats an attribute.
        `<text x="${(PAD + x * CW).toFixed(1)}" y="${yy}" textLength="${(s.length * CW).toFixed(1)}" lengthAdjust="spacing"${colour ? ` style="fill:${fill[colour]}"` : ''}>${esc(s)}</text>`;
    let body = '';
    if (e.kind === 'line') {
        const p = lineParts(e);
        body = t(0, p.clock, COLOUR.dim) + t(p.clock.length, p.who, COLOUR[e.who]) + t(p.clock.length + p.who.length, p.msg);
    } else if (e.kind === 'text') {
        body = t(0, e.text, e.style && COLOUR[e.style]);
    } else if (e.kind === 'power') {
        const { left, right } = powerLabel(e);
        const filled = barCells(e.watts);
        const x0 = PAD + left.length * CW;
        const top = (y(row) - FONT * 0.85).toFixed(1);
        body =
            t(0, left) +
            `<rect x="${x0.toFixed(1)}" y="${top}" width="${(filled * CW).toFixed(1)}" height="${FONT}" fill="#3fb950"/>` +
            `<rect x="${(x0 + filled * CW).toFixed(1)}" y="${top}" width="${((BAR_CELLS - filled) * CW).toFixed(1)}" height="${FONT}" fill="#30363d"/>` +
            t(left.length + BAR_CELLS, right);
    }
    return `<g class="f ${cls}">${body}</g>`;
}

const parts: string[] = [];
rows.forEach((r, i) => parts.push(rowSvg(r.e, i, anim(r.from, endMs))));
for (const b of bars) if (b.to > b.from) parts.push(rowSvg(b.e, b.row, anim(b.from, b.to)));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Terminal recording of npm run showcase: the network sets a 3 kW limit, the charger drops from 5000 W to 3000 W, then recovers to 5000 W when the limit ends.">
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:${FONT}px;fill:#c9d1d9;white-space:pre}
.f{opacity:0;animation-duration:${(endMs / 1000).toFixed(2)}s;animation-iteration-count:infinite;animation-timing-function:step-end}
${[...keyframes.values()].join('\n')}
</style>
<rect width="${W}" height="${H}" rx="8" fill="#0d1117"/>
<circle cx="20" cy="17" r="6" fill="#f85149"/><circle cx="40" cy="17" r="6" fill="#e3b341"/><circle cx="60" cy="17" r="6" fill="#3fb950"/>
<text x="${W / 2}" y="22" text-anchor="middle" style="fill:#8b949e;font-size:12px">npm run showcase (real run; quiet stretches shortened)</text>
${parts.join('\n')}
</svg>
`;
writeFileSync('docs/showcase.svg', svg);
console.log(`\nwrote docs/showcase.svg (${(svg.length / 1024).toFixed(0)} KB, ${(endMs / 1000).toFixed(0)} s loop) and docs/showcase.cast`);
