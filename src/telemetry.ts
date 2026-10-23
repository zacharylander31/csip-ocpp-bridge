// Turning meter readings (chargers, site meter) into the number CSIP-AUS
// telemetry reports: average power over one interval.
import type { Metered } from './csms.js';

export interface IntervalAverage {
    totalW: number; // all meters together
    samples: number; // readings used, across all meters
    chargersWithNoReadings: string[]; // counted as 0 W, see below
}

/**
 * Average power the meters (usually chargers) drew together over
 * [fromMs, toMs) (local clock). Returns undefined if none reported anything,
 * as there's nothing to say.
 *
 * Each charger: the mean of its readings in the interval. That equals the
 * time average only because chargers report at a steady rate; uneven
 * reporting would need time-weighting. The chargers' averages are then added.
 *
 * A charger with no readings counts as 0 W. Usually right: a charger with no
 * car sends no meter values. But a charger that has dropped off the network
 * also sends none and might still be drawing power, so the ids are returned
 * for the caller to log.
 */
export function averageW(chargers: Metered[], fromMs: number, toMs: number): IntervalAverage | undefined {
    let totalW = 0;
    let samples = 0;
    const chargersWithNoReadings: string[] = [];

    for (const charger of chargers) {
        const watts = charger.readings.filter((r) => r.at >= fromMs && r.at < toMs).map((r) => r.watts);
        if (watts.length === 0) {
            chargersWithNoReadings.push(charger.id);
            continue;
        }
        totalW += watts.reduce((a, b) => a + b, 0) / watts.length;
        samples += watts.length;
    }

    if (samples === 0) return undefined;
    return { totalW, samples, chargersWithNoReadings };
}
