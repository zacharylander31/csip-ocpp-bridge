# Recording script (2 minutes)

The story in one line: **the network sets 3 kW → the charger drops to 3 kW → the limit ends → the charger recovers.**

Target: under 2 minutes, readable at 1080p, no audio required (captions on screen).

## What to record

One terminal running `npm run showcase`. It runs the mock network, the real bridge program (`src/main.ts`) and a simulated charger, and prints a line for each step, coloured by who's speaking (`NETWORK`, `BRIDGE`, `CHARGER`), with a live power bar at the bottom. It takes about 60 s and ends with `RESULT: PASS`.

The README already has an animation of a real run (`docs/showcase.svg`, made by `npm run demo-animation`). The screen recording is for places that need a video: LinkedIn, a talk, an email.

## Before recording

- [ ] `npm ci` done and `npm run showcase` passed once in the last few minutes.
- [ ] Terminal font 18 pt or larger, dark theme, at least 100 columns wide (the longest line is ~100 characters) and 25 rows tall.
- [ ] A terminal that shows colours and redraws a line in place (Windows Terminal, macOS Terminal, any Linux terminal). If the bar prints a new line each time instead of updating, your terminal isn't seen as a TTY: run `npm run showcase -- --live`.
- [ ] Notifications off, unrelated windows closed, nothing personal on screen (home directory in the prompt, other tabs, real network or account details). A plain prompt helps: in bash, `PS1='$ '`.

## Timeline

| Time | On screen | Caption |
|---|---|---|
| 0:00–0:08 | Title card | "Australian networks can limit EV chargers over CSIP-AUS. Here's an open-source bridge." |
| 0:08–0:15 | Type `npm run showcase`, Enter | "A mock network, the real bridge and a simulated charger, on one laptop." |
| 0:15–0:25 | `NETWORK default limit 5 kW`, `BRIDGE capping CP1 to 5000 W`, `CHARGER drawing 5000 W` | "The network's default limit for this site is 5 kW. The bridge caps the charger over OCPP." |
| 0:25–0:35 | `NETWORK new control: limit this site to 3 kW from …` | "The network schedules a 3 kW limit." |
| 0:35–0:50 | Control starts: `BRIDGE capping CP1 to 3000 W`, bar drops to 3000 W | "The bridge passes it on; the charger drops to 3 kW within a second or two." |
| 0:50–1:05 | Bar holds at 3000 W (cut most of the 30 s here) | "It stays there for the whole control." |
| 1:05–1:15 | `NETWORK control ended`, bar back to 5000 W | "Limit ends: the charger recovers on its own." |
| 1:15–1:25 | `RESULT: PASS` | "The run checks itself: it fails if the charger ever goes over the limit." |
| 1:25–1:45 | Optional: `npm run failsafe-demo` (or a caption only) | "If the network link drops, the bridge falls back to the network's default limit." |
| 1:45–2:00 | End card: repo URL, and the "what doesn't work yet" list from the README | "Simulated chargers and a mock network today; tested with the real Open Dynamic Export in CI. Next: real chargers." |

Keep the clock times on screen: they show the timeline is real even where you cut.

## After recording

- [ ] Trim to under 2:00 and add captions.
- [ ] Check nothing personal is visible in any frame.
- [ ] Optional: regenerate the README animation from a fresh run with `npm run demo-animation` (writes `docs/showcase.svg` and `docs/showcase.cast` only if the run passed), and look at it in a browser before committing.
