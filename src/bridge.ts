// The bridge: CSIP-AUS import limit in, OCPP charging caps out.
//
// The limit comes from a LimitSource (limitSource.ts): our own CsipClient, or
// Open Dynamic Export over MQTT. Telemetry only runs when the source is a
// CsipClient; with ODE in front, ODE reports to the network itself.
//
// Three loops:
//  - poll loop: every `pollMs`, asks the source to refresh. For CsipClient
//    that fetches the latest clock, default and controls (real servers say
//    how often via pollRate, ~60 s); for MQTT it checks messages are arriving.
//  - apply loop: every `tickMs`, asks the source which limit applies now,
//    works out how much of it the chargers may use, and caps or uncaps only
//    the chargers whose share changed. Control start/end times are hit on
//    time even between polls, because the client decides from start/end on
//    server time.
//  - telemetry loop: at the end of every postRate interval (server clock,
//    lined up to whole multiples like 10:05:00, 10:10:00 for 300 s), averages
//    what the chargers drew, and what the site meter read, over that interval
//    and posts them to the server. Readings that fail to post are kept (up to
//    MAX_UNSENT) and sent first next time, after registering the mirrors
//    again in case the server dropped them.
//
// Fail-safe: if the source has had no good data for `commsLostAfterMs`, the
// bridge stops trusting the schedule and applies the default control from the
// last good data (CSIP-AUS default controls exist for exactly this). When good
// data arrives again, the schedule is back in charge. If the source never gave
// a default, there is nothing to fall back to and the caps are removed.
// TODO: check each network's rule for how long "lost" is before relying on this.
//
// The rest of the site: CSIP-AUS opModImpLimW limits the whole site's import,
// and the house uses some of it. With a site meter, the bridge estimates the
// house load (site meter minus what the chargers report) and gives the
// chargers only what's left. The house can be negative (solar exporting),
// which leaves the chargers more than the limit, and that's right: the site
// still imports no more than the limit. Without a site meter, the chargers
// are treated as the only load.
//
// Splitting: the chargers' budget is shared equally, rounded down to
// SHARE_STEP_W so the shares never add up to more than the budget. Simple and
// safe, but wasteful: a charger with no car keeps its share.
//
// Hysteresis: a lower share is sent at once (otherwise the site is over the
// limit), a higher one only when it's at least RAISE_HYSTERESIS_W higher, so
// meter noise doesn't send a new profile every tick. The cost: a charger can
// sit up to RAISE_HYSTERESIS_W below what it could have.
import { CsipClient } from './csipClient.js';
import { SETTLE_MS, type ManagedCharger, type Metered } from './csms.js';
import type { ActiveLimit, LimitSource } from './limitSource.js';
import type { MirrorKind } from './mirrorXml.js';
import { averageW } from './telemetry.js';

// Wait this long after an interval ends before averaging it, so a meter
// reading sent just before the end has time to arrive.
const TELEMETRY_GRACE_MS = 1000;
// Unsent readings kept while the server is unreachable (1 hour at 300 s).
const MAX_UNSENT = 12;
// postRate to use until the server tells us (SEP2 Client Handbook default).
const DEFAULT_POST_RATE_SEC = 300;

const SHARE_STEP_W = 100;
const RAISE_HYSTERESIS_W = 300;
const DEFAULT_CHARGER_IDLE_AFTER_MS = 15_000;
const DEFAULT_METER_SILENT_AFTER_MS = 15_000;

export interface BridgeOptions {
    pollMs?: number;
    tickMs?: number;
    commsLostAfterMs?: number; // no good data for this long -> apply the default
    siteMeter?: Metered; // omit to treat the chargers as the only load
    // A charger with no meter reading for this long has no car and counts as
    // drawing 0 W in the house load. Must be longer than the charger's
    // reporting interval, or a charging car looks like house load.
    chargerIdleAfterMs?: number;
    // No site meter reading for this long -> the chargers get nothing: we
    // can't tell how much room is left.
    meterSilentAfterMs?: number;
    log?: (msg: string) => void;
}

/** One change the bridge made to one charger, for checking afterwards. */
export interface AppliedChange {
    chargerId: string;
    siteLimitW: number | undefined; // the network's limit for the whole site
    houseW: number | undefined; // the house load estimate used; undefined without a site meter
    limitW: number | undefined; // this charger's share; undefined = cap removed
    source: ActiveLimit['source'];
    commsLost: boolean; // true if this was the fail-safe default
    sentAt: number; // ms since epoch
    ackedAt: number; // when the charger replied Accepted
}

/** One telemetry interval the bridge measured, for checking afterwards. */
export interface TelemetryInterval {
    startSec: number; // server clock, unix seconds
    durationSec: number;
    fromMs: number; // the same interval on the local clock, as averaged
    toMs: number;
    avgW?: number; // all chargers; unset if none reported
    siteAvgW?: number; // the site meter; unset if there's none or it didn't report
    samples: number;
    unposted: MirrorKind[]; // mirrors still waiting for this interval's reading
    postedAt?: number; // ms since epoch; unset until the server accepted all of them
}

export class Bridge {
    readonly changes: AppliedChange[] = [];
    readonly telemetry: TelemetryInterval[] = [];
    private pollMs: number;
    private tickMs: number;
    private commsLostAfterMs: number;
    private siteMeter?: Metered;
    private log: (msg: string) => void;
    private running = false;
    private loops: Promise<void>[] = [];

    private commsLost = false; // only used to log the moment it changes
    private telemetryClient?: CsipClient; // the source, if it's one that takes telemetry

    // What each charger has accepted, by charger id. A charger that's missing
    // is 'unknown', so it always gets sent its share on the first tick: we
    // don't know what profile it already has.
    private appliedW = new Map<string, number | undefined>();

    private houseW?: number; // house load estimate: site meter minus chargers
    private lastChangeAt = 0; // when the last batch of changes finished (all replies in)
    private chargerIdleAfterMs: number;
    private meterSilentAfterMs: number;
    private meterSilent = false; // only used to log the moment it changes
    private createdAt = Date.now();

    // Telemetry.
    private mirrors: MirrorKind[];
    private mirrorsReady = false; // all registered and no post has failed since
    private postRateSec = DEFAULT_POST_RATE_SEC;
    private unsent: TelemetryInterval[] = []; // oldest first

    constructor(
        private source: LimitSource,
        private chargers: ManagedCharger[],
        opts: BridgeOptions = {},
    ) {
        if (chargers.length === 0) throw new Error('bridge needs at least one charger');
        this.pollMs = opts.pollMs ?? 60_000;
        this.tickMs = opts.tickMs ?? 1000;
        // Ours, else the source's, else three missed polls in a row.
        this.commsLostAfterMs = opts.commsLostAfterMs ?? source.commsLostAfterMs ?? 3 * this.pollMs;
        if (source instanceof CsipClient) this.telemetryClient = source;
        this.siteMeter = opts.siteMeter;
        this.chargerIdleAfterMs = opts.chargerIdleAfterMs ?? DEFAULT_CHARGER_IDLE_AFTER_MS;
        this.meterSilentAfterMs = opts.meterSilentAfterMs ?? DEFAULT_METER_SILENT_AFTER_MS;
        this.mirrors = this.siteMeter ? ['chargers', 'site'] : ['chargers'];
        this.log = opts.log ?? ((m) => console.log(`[BRIDGE] ${m}`));
    }

    /**
     * Poll once (so we start with a real limit), then run all loops. Doesn't
     * throw if the server is unreachable: a gateway that boots during an outage
     * must still run, so it starts in the fail-safe state and keeps trying.
     */
    async start(): Promise<void> {
        await this.tryPoll();
        this.running = true;
        this.loops = [this.pollLoop(), this.applyLoop(), this.telemetryLoop()];
    }

    /** Stop all loops and wait for anything in flight to finish. */
    async stop(): Promise<void> {
        this.running = false;
        await Promise.all(this.loops);
    }

    private async pollLoop(): Promise<void> {
        while (this.running) {
            await this.sleepWhileRunning(this.pollMs);
            if (!this.running) break;
            await this.tryPoll();
        }
    }

    // A failed refresh leaves the source's last good state untouched, so the
    // schedule keeps being followed until commsLostAfterMs runs out.
    private async tryPoll(): Promise<void> {
        try {
            await this.source.refresh();
        } catch (err) {
            this.log(`poll failed: ${(err as Error).message}`);
        }
    }

    // A loop with await, not setInterval: a slow charger reply can't cause
    // two overlapping SetChargingProfile calls to the same charger.
    private async applyLoop(): Promise<void> {
        while (this.running) {
            await this.applyCurrentLimit();
            await this.sleepWhileRunning(this.tickMs);
        }
    }

    private async applyCurrentLimit(): Promise<void> {
        // lastUpdatedAt 0 (never) counts as comms lost.
        const commsLost = Date.now() - this.source.lastUpdatedAt > this.commsLostAfterMs;
        if (commsLost !== this.commsLost) {
            this.commsLost = commsLost;
            this.log(commsLost
                ? `COMMS LOST: no good data for over ${this.commsLostAfterMs / 1000} s, applying the default control`
                : 'comms restored, following the schedule again');
        }
        const limit = commsLost ? this.source.defaultImportLimit() : this.source.activeImportLimit();

        this.updateHouseLoad();
        const houseW = this.currentHouseW();
        this.logMeterChange(houseW);
        let budgetW: number | undefined;
        if (limit.importLimitW !== undefined) {
            budgetW = !this.siteMeter
                ? limit.importLimitW
                : houseW === undefined
                  ? 0 // no estimate: can't tell how much room there is, so take none
                  : Math.max(0, limit.importLimitW - houseW);
        }
        const shareW =
            budgetW === undefined
                ? undefined
                : Math.floor(budgetW / this.chargers.length / SHARE_STEP_W) * SHARE_STEP_W;

        const outOfDate = this.chargers.filter((c) => this.needsUpdate(c.id, shareW));
        if (outOfDate.length === 0) return; // nothing changed (enough)

        const why = limit.source === 'control' ? `control ${limit.mRID}` : limit.source;
        const house = !this.siteMeter
            ? ''
            : houseW === undefined
              ? ', house load unknown'
              : `, house ${Math.round(houseW)} W`;
        this.log(
            limit.importLimitW === undefined
                ? `no limit (${why}) -> removing caps`
                : `site limit ${limit.importLimitW} W (${why})${house} -> ${shareW} W each for ${outOfDate.map((c) => c.id).join(', ')}`,
        );

        // Send to all chargers at once, not one after another. When the limit
        // drops, the chargers not yet updated are still on the old, higher
        // share, so the site is briefly over the limit; in parallel that
        // window is one round trip instead of one per charger.
        await Promise.all(outOfDate.map((c) => this.applyTo(c, shareW, houseW, limit, commsLost)));
        this.lastChangeAt = Date.now();
    }

    private needsUpdate(chargerId: string, shareW: number | undefined): boolean {
        if (!this.appliedW.has(chargerId)) return true;
        const applied = this.appliedW.get(chargerId);
        if (applied === shareW) return false;
        if (applied === undefined || shareW === undefined) return true; // cap added or removed
        return shareW < applied || shareW >= applied + RAISE_HYSTERESIS_W;
    }

    // House load = site meter - what the chargers report. Only from readings
    // taken SETTLE_MS after the last change finished: before that, the site
    // meter and the chargers may have caught the chargers at different limits.
    // A stale (higher) charger reading would make the house look smaller and
    // hand the chargers more than the limit allows.
    private updateHouseLoad(): void {
        if (!this.siteMeter) return;
        const settledAt = this.lastChangeAt + SETTLE_MS;
        const site = this.siteMeter.readings.at(-1);
        if (!site || site.at < settledAt) return;

        let chargersW = 0;
        for (const charger of this.chargers) {
            const r = charger.readings.at(-1);
            // Offline, or no car: 0 W. If it's really drawing, that overstates
            // the house, which leaves the chargers less: the safe side.
            if (!charger.connected || !r || site.at - r.at > this.chargerIdleAfterMs) continue;
            if (r.stopped) {
                // It said it stopped: 0 W, whatever caps changed since (no car to obey them).
                // But wait for a site reading taken after that, which no longer has the car in it.
                if (r.at > site.at) return;
                continue;
            }
            if (r.at < settledAt) return; // from before the change; wait for its next report
            chargersW += r.watts;
        }
        this.houseW = site.watts - chargersW;
    }

    // The latest meter reading's age, not the estimate's: while waiting for a
    // charger to report, the estimate is held, and that isn't a silent meter.
    private currentHouseW(): number | undefined {
        const site = this.siteMeter?.readings.at(-1);
        if (!site || Date.now() - site.at > this.meterSilentAfterMs) return undefined;
        return this.houseW;
    }

    // Says so when the meter goes quiet or comes back. At boot it's normal to
    // have no estimate yet, so that only counts once the silent time has passed.
    private logMeterChange(houseW: number | undefined): void {
        if (!this.siteMeter) return;
        const silent = houseW === undefined && Date.now() - this.createdAt > this.meterSilentAfterMs;
        if (silent === this.meterSilent) return;
        this.meterSilent = silent;
        this.log(silent
            ? `SITE METER SILENT: no usable reading for over ${this.meterSilentAfterMs / 1000} s, chargers get 0 W until it's back`
            : `site meter back: house ${Math.round(houseW ?? 0)} W`);
    }

    // Never throws: one charger failing mustn't stop the others being updated.
    // On failure appliedW is unchanged, so the next tick tries again.
    private async applyTo(
        charger: ManagedCharger,
        shareW: number | undefined,
        houseW: number | undefined,
        limit: ActiveLimit,
        commsLost: boolean,
    ): Promise<void> {
        const sentAt = Date.now();
        let status: string;
        try {
            if (shareW === undefined) {
                status = await charger.removeCap();
                // 'Unknown' means the charger had no cap to remove, which is the state we want.
                if (status === 'Unknown') status = 'Accepted';
            } else {
                status = await charger.capPower(shareW);
            }
        } catch (err) {
            this.log(`couldn't update ${charger.id}, will retry: ${(err as Error).message}`);
            return;
        }

        if (status !== 'Accepted') {
            this.log(`${charger.id} said ${status}, will retry`);
            return;
        }
        this.appliedW.set(charger.id, shareW);
        this.changes.push({
            chargerId: charger.id,
            siteLimitW: limit.importLimitW,
            houseW: this.siteMeter ? houseW : undefined,
            limitW: shareW,
            source: limit.source,
            commsLost,
            sentAt,
            ackedAt: Date.now(),
        });
    }

    private async telemetryLoop(): Promise<void> {
        const client = this.telemetryClient;
        if (!client) return; // not a CsipClient: someone else reports to the network
        // The interval we're in when the loop starts began before we were
        // watching, so its average would be too low. Skip it.
        const startedAt = Date.now();
        let lastEndSec = 0; // the previous interval, server clock
        let lastToMs = 0; // ... and where it ended on the local clock
        while (this.running) {
            // Wait for a good poll: it finds the links and the server clock.
            if (client.lastUpdatedAt === 0) {
                await this.sleepWhileRunning(this.tickMs);
                continue;
            }
            if (!client.takesTelemetry) {
                this.log('server has no MirrorUsagePointListLink, not posting telemetry');
                return;
            }
            // Register first: the server's answer sets postRate, which decides
            // where the interval boundaries fall.
            // (Also where mirrors the server dropped get registered again.)
            if (!this.mirrorsReady) await this.tryRegisterMirrors(client);

            // Sleep to the end of the current interval, on the server's clock.
            const durationSec = this.postRateSec;
            // Each poll re-estimates the server clock, which can move it by up
            // to a second (/tm has 1 s resolution). So: never measure the same
            // interval twice if the estimate moved back, and start each
            // interval exactly where the last one ended on the local clock, so
            // no reading is counted twice or missed.
            let endSec = (Math.floor(client.serverTimeSec() / durationSec) + 1) * durationSec;
            if (endSec <= lastEndSec) endSec = lastEndSec + durationSec;
            const startSec = endSec - durationSec;
            const fromMs = startSec === lastEndSec ? lastToMs : client.localTimeMs(startSec);
            const toMs = client.localTimeMs(endSec);
            lastEndSec = endSec;
            lastToMs = toMs;
            await this.sleepWhileRunning(toMs + TELEMETRY_GRACE_MS - Date.now());
            if (!this.running) break;
            if (fromMs < startedAt) continue;

            this.measure(startSec, durationSec, fromMs, toMs);
            await this.sendUnsent(client);
        }
    }

    private measure(startSec: number, durationSec: number, fromMs: number, toMs: number): void {
        const chargers = averageW(this.chargers, fromMs, toMs);
        const site = this.siteMeter ? averageW([this.siteMeter], fromMs, toMs) : undefined;
        if (chargers && chargers.chargersWithNoReadings.length > 0) {
            this.log(`telemetry: no readings from ${chargers.chargersWithNoReadings.join(', ')}, counted as 0 W`);
        }
        if (this.siteMeter && !site) this.log(`telemetry: no site meter readings for ${startSec}+${durationSec}s`);
        if (!chargers && !site) {
            this.log(`telemetry: no readings for ${startSec}+${durationSec}s, nothing to post`);
            return;
        }

        const interval: TelemetryInterval = {
            startSec,
            durationSec,
            fromMs,
            toMs,
            avgW: chargers?.totalW,
            siteAvgW: site?.totalW,
            samples: (chargers?.samples ?? 0) + (site?.samples ?? 0),
            unposted: this.mirrors.filter((kind) => (kind === 'site' ? site : chargers) !== undefined),
        };
        this.telemetry.push(interval);
        this.unsent.push(interval);
        if (this.unsent.length > MAX_UNSENT) {
            const dropped = this.unsent.shift()!;
            this.log(`telemetry: too many unsent, dropped ${dropped.startSec}+${dropped.durationSec}s`);
        }
    }

    // Never throws. Leaves mirrorsReady false on failure, so it's tried again.
    private async tryRegisterMirrors(client: CsipClient): Promise<void> {
        try {
            const postRates = [];
            for (const kind of this.mirrors) postRates.push(await client.registerMirror(kind));
            // Each mirror has its own postRate; servers give the same one to
            // all of a gateway's mirrors, so use the shortest in case one doesn't.
            this.postRateSec = Math.min(...postRates);
            this.mirrorsReady = true;
            this.log(`telemetry: ${this.mirrors.join(' and ')} mirror(s) registered, posting every ${this.postRateSec} s`);
        } catch (err) {
            this.log(`telemetry: couldn't register mirrors, will retry: ${(err as Error).message}`);
        }
    }

    // Oldest first, stopping at the first failure so they arrive in order.
    // Without registered mirrors they wait for the next interval, when the
    // loop registers again.
    private async sendUnsent(client: CsipClient): Promise<void> {
        if (!this.mirrorsReady) return;
        while (this.unsent.length > 0) {
            const interval = this.unsent[0];
            // One mirror at a time, ticking each off, so a retry after a
            // failure doesn't post the same reading to a mirror twice.
            while (interval.unposted.length > 0) {
                const kind = interval.unposted[0];
                try {
                    await client.postReading(kind, {
                        avgW: (kind === 'site' ? interval.siteAvgW : interval.avgW)!,
                        startSec: interval.startSec,
                        durationSec: interval.durationSec,
                    });
                } catch (err) {
                    // Could be the link, or the server may have deleted our
                    // mirror (404). Registering again covers both: it's
                    // harmless if the mirror still exists, since the server
                    // just updates it.
                    this.log(`telemetry: ${kind} post failed, will retry: ${(err as Error).message}`);
                    this.mirrorsReady = false;
                    return;
                }
                interval.unposted.shift();
            }
            interval.postedAt = Date.now();
            this.unsent.shift();
            const site = interval.siteAvgW === undefined ? '' : `, site ${Math.round(interval.siteAvgW)} W`;
            const chargers = interval.avgW === undefined ? 'no charger readings' : `chargers ${Math.round(interval.avgW)} W`;
            this.log(`telemetry: posted ${chargers}${site} for ${interval.startSec}+${interval.durationSec}s (${interval.samples} readings)`);
        }
    }

    // Sleep in short steps so stop() doesn't wait out a whole 60 s poll interval.
    private async sleepWhileRunning(ms: number): Promise<void> {
        const until = Date.now() + ms;
        while (this.running && Date.now() < until) {
            await new Promise((r) => setTimeout(r, Math.min(100, until - Date.now())));
        }
    }
}
