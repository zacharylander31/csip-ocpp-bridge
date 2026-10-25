# Tab C notes: runtime and packaging (23 Oct 2026)

Branch `claude/tab-c-runtime-71d1a5`. Written by Claude; Zach reviews. Ports: 8110 (HTTP) and 9030–9031 (OCPP). Merged main at 418ce64 (maxVoltage, SETTLE_MS) before finishing.

## What I built

| File | What it does |
|---|---|
| `src/config.ts` | `loadConfig(file)`: reads the config, strips comments, validates everything, merges charger settings (built-in default → `chargerDefaults` → per charger). Throws `ConfigError` with every problem and its path. Also returns `warnings`. MQTT password from env `BRIDGE_MQTT_PASSWORD` only. |
| `src/log.ts` | `createLogger(component)` with debug/info/warn/error; text or JSON lines; UTC timestamps; warn/error to stderr. `logFn(component)` adapts it to the `(msg) => void` that Bridge, Manager and OdeMqttSource take. Repeated warnings folded to once a minute. No dependencies. |
| `src/main.ts` | `npm start`. Loads config (`--config`, `BRIDGE_CONFIG`, or `./config.json`; `--check` validates and exits), starts OCPP server → limit source → bridge. Warns when an unknown charger connects. SIGINT/SIGTERM: clean shutdown within 10 s, caps left in place. Exit 0 / 1 (crash, timeout) / 2 (bad config). |
| `src/runChargerSim.ts` | `npm run charger-sim -- --url ws://localhost:9030/CP1 [--protocol 1.6] [--phases 3] [--amps-only] [--max-w] [--min-amps] [--voltage]`. One `SimCharger`, waits for the bridge, prints `drawing N W` on change and every 5 s. |
| `src/checkConfig.ts` | `npm run config-test`: 29 checks on the loader (examples load, defaults, overrides, env password, warnings, every rejection). ~1 s. |
| `src/runMain.ts` | `npm run runtime-demo` (8110 / 9031): spawns `main.ts` as a real process. Bad config → exit 2; mock CSIP (5 kW → 3 kW for 8 s → 5 kW) caps an in-process sim 5000 → 3000 → 5000; unknown id CPX warned; log line format; SIGTERM → exit 0 and the sim keeps 5000 W. ~25 s. |
| `config.example.json` | Real site with ODE (`ode-mqtt`, `mqtt://mosquitto:1883`, port 9000), commented. |
| `config.example.mock-csip.json` | One-machine try-out: `csip` at `http://localhost:8080` (`npm run mock-csip`), OCPP port 9030. |
| `tsconfig.build.json` | `npm run build`: compiles `src/` to `dist/` for the Docker image. |
| `Dockerfile`, `.dockerignore` | Two stages on `node:24-alpine` (same as ODE): build with tsc, then prod deps only + `dist/`, `USER node`, `CMD node dist/main.js`. `npm ci --ignore-scripts`. |
| `docker-compose.yml` | `bridge` (port 9000, `./config.json` mounted read-only), `mosquitto` (`eclipse-mosquitto:2.0.22`, no published port), `open-dynamic-export` (`longzhengau/open-dynamic-export:v0.20.0`, port 3000, `./ode/config` and `./ode/logs` mounted, as in ODE's own compose). |
| `mosquitto/mosquitto.conf` | Listener 1883, anonymous (safe because not published), no persistence. |
| `ode/config.example.json` | ODE config: ODE's own example + `setpoints.csipAus` (with `fixedDefault`) + `publish.mqtt` to the compose broker. Validated against ODE's `config.schema.json` (v0.20.0) with ajv. |
| `docs/install.md`, `docs/configuration.md`, `docs/testing.md` | Tab D's placeholders filled; new demos and the 3-terminal manual run added. |

## Results

- `npm run typecheck` and `npm run build` pass. `config-test` 3/3, `runtime-demo` 3/3, after merging main 418ce64.
- All 10 existing demos pass (demo, check-csip, bridge-demo, failsafe-demo, telemetry-demo, site-demo, ode-demo, ocpp16-demo, amps-demo, reconnect-demo), run one after another, before and after the merge.
- **Manual check (the "done" criterion):** `npm run mock-csip` + `npm start -- --config config.example.mock-csip.json` + `npm run charger-sim -- --url ws://localhost:9030/CP1`: the charger went 5000 → 3000 (at the control, +10 s) → 5000 W (+40 s), bridge logs `SetChargingProfile ... Accepted` each time.
- **Docker: not tested. Docker isn't installed on this machine** (and no WSL), so neither `docker compose config` nor `docker compose up` was run, and the image was never built. `npm run build` (what the Dockerfile runs) works. The compose file has not been checked by any YAML parser. **First thing to do on a machine with Docker:** `docker compose config`, `docker compose build`, then `docker compose run --rm bridge node dist/main.js --check`.
- Shutdown by real SIGTERM is only tested on Linux (CI). On Windows the demo triggers the same `shutdown()` through an IPC message, because Windows can't send signals.

## Decisions (plain words)

1. **JSON with comments, not YAML.** ODE's config is JSON, so an installer uses one format. No parser dependency (YAML would need one, and has traps like `no` = false). Plain JSON can't have comments, which an example file needs, so `stripJsonComments` blanks them out before `JSON.parse`. It blanks rather than deletes, so JSON.parse's line/column in errors still match the file. It skips over strings, so `"mqtt://host"` isn't treated as a comment.
2. **Strict validation.** Unknown keys are errors (a typo must not silently become a default). All problems are reported in one go. Ranges are sanity checks against typos (voltage 180–260, min amps 0–32, port 1–65535), not physics.
3. **One place for each timeout.** With `ode-mqtt`, comms-lost time is `limitSource.commsLostAfterMs` (Tab A's option); `bridge.commsLostAfterMs` is rejected so there aren't two settings that fight. With `csip` it's `bridge.commsLostAfterMs` and must be longer than `pollMs`.
4. **`fallbackImportLimitW` lives under `limitSource`** (it's an OdeMqttSource option) and is set in the example. Missing → a start-up warning explaining when it matters.
5. **`maxVoltage` (from main's 418ce64).** Exposed per charger and in `chargerDefaults`, default 253 V (AS 60038 top, so an amps cap stays within the share at any legal voltage); must be ≥ `voltage`. An amps charger with `maxVoltage` below 253 V gets a start-up warning, not an error (a site with a measured lower maximum may want it). `voltage` (230) now only decides the 6 A minimum for W chargers. My checks read the sim's own power, not readings after an ack, so `SETTLE_MS` isn't needed there.
6. **Logging levels are guessed for other modules' messages.** Bridge/Manager/OdeMqttSource log plain strings; `logFn` makes lines with words like `fail`, `couldn't`, `COMMS LOST`, `offline`, `Rejected` into warnings. A heuristic, but all the messages are ours; a proper fix is a level-aware log option in those modules (see "outside my files").
7. **Only warnings/errors are folded.** Info lines are state changes, and the same change coming back is news (an early version folded them too and hid `site limit 5000 W (default)` when a control ended).
8. **Shutdown leaves caps in place.** Removing caps would let chargers draw full power while nothing enforces the network limit. On restart the bridge sends every charger its share on the first tick (its "applied" map starts empty). Cost: if the bridge is gone for good, chargers keep their last cap; the uninstall guide says to repoint chargers first.
9. **Order at start:** OCPP server first (chargers can connect while we fetch the first limit), then the source, then the bridge. Bridge.start() doesn't throw if the source is down, so the box starts during an outage too.
10. **Configured chargers are created before they connect.** Bridge takes `ManagedCharger` objects in its constructor, but Manager only creates them on connect. Waiting for every charger would block the whole site on one offline charger. So main.ts creates them and puts them in `manager.chargers`; Manager reuses an existing entry on connect (that's its reconnect path). Side effect: the first connect is logged `connected (OCPP 2.0.1), reconnect`.
11. **Docker image runs compiled JS with `node`**, not tsx: no esbuild in production, faster start, and `node` as the process receives SIGTERM directly (`npm start` would sit in between). `init: true` in compose. ODE's env vars are written into compose (they're not secrets), so the installer copies two files instead of three. ODE's `privileged: true` is commented out: it's only for USB RS-485 devices and gives the container full host access.
12. **Images pinned:** ODE `v0.20.0` (16 Jul 2026, the same commit `bc807ab` Tab A built the MQTT format from), mosquitto `2.0.22`, `node:24-alpine`.
13. **Broker not published** on the host, so anonymous MQTT is only reachable by ODE and the bridge.

## Changes outside my files (please check when merging)

- `package.json`: scripts `start`, `build`, `charger-sim`, `config-test`, `runtime-demo`; `"engines": { "node": ">=24" }`. No new dependencies.
- `.gitignore`: added `/config.json`, `ode/config/`, `ode/logs/` (site config, ODE certificate and key).
- New directories `ode/` and `mosquitto/` (not in the ownership table; they belong to docker-compose).
- I did **not** touch `src/csms.ts`, `src/bridge.ts`, `src/chargerSim.ts`, `.github/workflows/ci.yml`, `README.md`, `docs/recording-script.md` or `CLAUDE.md`.

## Requests for the main session / other owners

- **`ci.yml`:** add steps `npm run config-test`, `npm run runtime-demo`, and `npm run build`. Add `docker build .` and `docker compose config` (ubuntu-latest has Docker) — that would be the first real check of my Docker files.
- **`csms.ts`:** (a) a `Manager.addCharger(id)` / `expect(id)` method instead of main.ts writing into `manager.chargers`; and don't log ", reconnect" for a charger that has never been connected. (b) **reject unknown charger ids at the WebSocket handshake** (ocpp-rpc's `auth` callback). Today an unconfigured charger is accepted and never capped; main.ts only warns.
- **`bridge.ts`:** (a) an optional `log(level, msg)` so log levels aren't guessed from words; (b) skip offline chargers instead of trying (and warning) every tick; (c) offline chargers still take a share; fine and safe, but worth a decision.
- **`chargerSim.ts` (Tab B):** an auto-reconnect option, so `charger-sim` survives a bridge restart (useful for the recording: stop/start the bridge on camera).
- **`docs/recording-script.md` (Tab D) Version B commands:** Bridge window `npm start -- --config config.example.mock-csip.json`; Charger window `npm run charger-sim -- --url ws://localhost:9030/CP1`. Starting the network last works: the bridge starts with the server down (logs `poll failed`, no caps) and picks it up on the next 2 s poll.
- **README (Tab D / main):** quick start can now mention `npm start` and `docker compose up -d` (once Docker is actually tested).

## TODOs

- **Test Docker for real** (see Results). Also check the image size and that it runs on arm64 (Pi): `node:24-alpine` and both other images are multi-arch, but untested.
- Run against a real ODE (its mock SEP2 server) through the compose stack.
- `docker compose up` with a bad config restart-loops (`unless-stopped`); fine, but the install guide tells people to `--check` first.
- Persist state across restarts (learned default; Tab A's TODO).
- Config reload without restart: not planned for v0.1.
- Site meter config: Bridge supports one, but only the sim exists. Add `siteMeter` to the config when there's a real meter (ODE site samples or SunSpec).
- Health check for Docker (`HEALTHCHECK`), e.g. a small HTTP status endpoint: not built.
- Caps don't expire (no `validTo`): if the bridge dies for good, chargers stay capped. Phase 2 "crash safety".
