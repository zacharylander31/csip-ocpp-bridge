// Simulated site meter: what a meter at the site's connection point (the
// main switchboard) would read. That's the whole site's import: the house
// plus the EV chargers. Negative when solar is exporting.
//
// A real one would be a CT meter read over Modbus/SunSpec, or a battery or
// inverter API; Open Dynamic Export already reads many of these. This one
// just adds a house load you set to what the simulated chargers draw.
import type { SimCharger } from './chargerSim.js';
import { addReading, type Metered, type PowerReading } from './csms.js';

export class SimSiteMeter implements Metered {
    readonly id = 'site';
    readonly readings: PowerReading[] = [];
    private houseW: number;
    private timer?: NodeJS.Timeout;

    constructor(
        private chargers: SimCharger[],
        opts: { houseW?: number; intervalMs?: number } = {},
    ) {
        this.houseW = opts.houseW ?? 0;
        // First reading straight away, like a real meter once it's connected.
        this.read();
        this.timer = setInterval(() => this.read(), opts.intervalMs ?? 1000);
    }

    /** Change the house load, e.g. a kettle going on. Shows up at the next reading. */
    setHouseW(watts: number): void {
        this.houseW = watts;
    }

    /** What the site actually imports right now (the true value, not the last reading). */
    siteW(): number {
        return this.houseW + this.chargers.reduce((sum, c) => sum + c.currentPowerW(), 0);
    }

    stop(): void {
        clearInterval(this.timer);
    }

    private read(): void {
        addReading(this.readings, { at: Date.now(), watts: this.siteW() });
    }
}
