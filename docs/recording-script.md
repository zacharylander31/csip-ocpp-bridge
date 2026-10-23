# Recording script (2 minutes)

The story in one line: **the network sets 3 kW → the charger drops to 3 kW → the limit ends → the charger recovers.**

Target: under 2 minutes, readable at 1080p, no audio required (captions on screen). Export a short GIF of the middle section for the README.

## Which version to record

- **Version A (works today):** one terminal running `npm run bridge-demo`. Everything is in one log, which is honest but busy.
- **Version B (after v0.1 lands, preferred):** three terminals, one per part of the system, so a viewer *sees* the limit travel from the network to the charger. Needs a standalone bridge (`src/main.ts`, Tab C) that can be pointed at the mock CSIP-AUS server, and a standalone charger simulator runner (Tab B). See `plans/notes/tab-d.md`.

## Before recording

- [ ] `npm ci` done, `npm run typecheck` passes, and the demo passed in the last run.
- [ ] Terminal font 18 pt or larger, dark theme, window wide enough that log lines don't wrap.
- [ ] Notifications off, unrelated windows closed.
- [ ] Do a full dry run first. The 3 kW control in `npm run mock-csip` starts **10 s** after the server starts and lasts **30 s**, so timing matters.

## Version B: three terminals

Lay the terminals side by side, left to right in the order the limit travels:

| Window | Title | Command | What the viewer watches |
|---|---|---|---|
| Left | **Network** (mock CSIP-AUS server) | `npm run mock-csip` | Polls arriving; the control's start and end |
| Middle | **Bridge** | *TODO (Tab C):* bridge with the demo config pointing at `http://localhost:8080/dcap` | `site limit 3000 W (control)` and `SetChargingProfile ... Accepted` |
| Right | **Charger** | *TODO (Tab B):* standalone simulated charger | `now drawing 3000 W`, then back up |

| Time | On screen | Caption |
|---|---|---|
| 0:00–0:10 | Title card | "Australian networks can now limit EV chargers over CSIP-AUS. Open source." |
| 0:10–0:20 | Start the Charger and Bridge windows. Charger connects and starts charging | "A charger connects over OCPP, the protocol chargers already speak." |
| 0:20–0:30 | Start the Network window. Bridge picks up the 5 kW default; charger draws 5 kW | "The network's default limit for this site: 5 kW." |
| 0:30–0:40 | Control starts. Bridge logs 3 kW; charger accepts the profile | "Peak period: the network sets a 3 kW import limit." |
| 0:40–1:00 | Charger at 3000 W, reading after reading | "The charger drops to 3 kW and stays there." |
| 1:00–1:10 | Control ends. Bridge logs 5 kW default; charger goes back up | "Limit ends: the charger recovers on its own." |
| 1:10–1:35 | Optional: stop the Network window to show the fail-safe (or cut to `npm run failsafe-demo`) | "If the network link drops, the bridge falls back to the network's default limit." |
| 1:35–2:00 | End card: repo URL, "what works / what doesn't yet" from the README | "Simulated chargers and a mock server today. Next: real chargers, alongside Open Dynamic Export." |

Note: start the Network window last (or restart it) so the 10 s countdown to the control begins when you're ready.

## Version A: one terminal (fallback)

1. Clear the terminal, type `npm run bridge-demo`, press Enter.
2. Default 5 kW: both chargers settle at **2500 W** each.
3. About 6 s in, the 3 kW control starts: both drop to **1500 W** each (3 kW for the site).
4. 8 s later the control ends: both return to **2500 W**.
5. Hold on the final lines (`shares applied` and `RESULT: PASS`) for 5 s.

Captions as in Version B, but say "two chargers share the site's 3 kW".

## After recording

- [ ] Trim to under 2:00 and add captions.
- [ ] Cut a ~15 s GIF of the drop and recovery, and replace the placeholder at the top of `README.md`.
- [ ] Don't show anything personal in the recording: home directory paths, other windows, real network or account details.
