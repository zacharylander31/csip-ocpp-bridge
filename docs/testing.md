# Testing

Every demo starts its own mock CSIP-AUS server and simulated chargers, checks the result, prints `PASS` or `FAIL`, and **exits non-zero on failure**. CI runs all of them on every push and pull request ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

```bash
npm ci
npm run typecheck
npm run showcase
```

Each demo uses its own ports, so they can also run side by side.

| Command | Ports (CSIP · OCPP) | Takes | What it proves |
|---|---|---|---|
| `npm run typecheck` | — | seconds | The TypeScript compiles with no type errors. |
| `npm run showcase` | 8140 · 9061 | ~60 s | **The README demo**, written for people watching rather than developers. A mock CSIP-AUS network, the real program (`src/main.ts`, run as its own process) and one simulated charger: 5 kW default → the network publishes a 3 kW control 10 s ahead → the charger drops to 3000 W → the control ends 30 s later → back to 5000 W. Prints `NETWORK` / `BRIDGE` / `CHARGER` lines and a live power bar; checks the charger never drew over 3 kW (from 5 s into the control) and recovered, and that the bridge exits 0 on shutdown. `--verbose` adds the bridge's own log. |
| `npm run demo` | — · 9000 | ~15 s | **OCPP only.** One simulated charger draws 7.4 kW, obeys a 3 kW `SetChargingProfile`, and goes back to 7.4 kW after `ClearChargingProfile`. Checked from the charger's own meter values. |
| `npm run check-csip` | 8081 · — | ~10 s | **CSIP-AUS client only.** Picks the right limit as time passes (default → control → default) without re-polling; handles the `ns2` namespace prefix; uses the server's clock when it is an hour off; reports no limit when there's no default control (404). |
| `npm run bridge-demo` | 8082 · 9001 | ~20 s | **End to end.** Site default 5 kW → 3 kW control for 8 s → default. Two chargers each draw 2500 → 1500 → 2500 W. Checks each charger's readings between each acknowledgement and its next command. |
| `npm run failsafe-demo` | 8083 · 9002 | ~25 s | **Comms loss.** One charger: 5 kW default → 3 kW control → link down → after 3 s with no good poll (3 polls) the default 5 kW applies → link up → back to 3 kW → control ends → 5 kW. |
| `npm run telemetry-demo` | 8084 · 9003 | ~40 s | **Telemetry.** Two chargers, 5 kW → 3 kW for 15 s → 5 kW, posted every 5 s. Checks each interval's value, that every interval arrives in order with no gaps, and that the bridge re-registers when the server forgets its mirror. |
| `npm run site-demo` | 8085 · 9004 | ~35 s | **Site meter.** House load changes (kettle, solar export) and a 3 kW control. Chargers get `limit − house`: 2000, 1000, 2000, 1000, 2200, 3200 W each. The site goes over the limit only within 3 s of a change, and site telemetry matches. |
| `npm run site-meter-demo` | 8150 (MQTT), 8151 (REST) · 9070 | ~60 s | **The site meter in the real program.** `src/main.ts` with a fake ODE at the protocol level (MQTT limits, REST status API) and two chargers reporting every 5 s. No sample yet → 0 W; house 1 kW → kettle 3 kW → 1 kW → 3 kW control → solar export: 2000, 1000, 2000, 1000, 2200 W each. ODE's meter dies (date stops changing) → 0 W, in `silentAfterMs` → back; ODE's API fails → 0 W → back; control ends → 3200 W. A charger that goes offline while drawing counts as house load. The site is over the limit only just after a change. Bad status responses never become readings. |
| `npm run ode-demo` | 8090 (MQTT) · 9010 | ~50 s | **Limits from Open Dynamic Export over MQTT**, with a fake ODE publishing ODE-shaped messages: default → control → bad messages ignored → broker down → fail-safe default → back. A value seen while ODE ramps isn't learnt as the default. |
| `npm run ocpp16-demo` | — · 9020 | ~15 s | **OCPP 1.6J and 2.0.1** chargers on the same server, capped through the same API. |
| `npm run amps-demo` | — · 9021 | ~15 s | **Amps-only chargers**, single and three phase, the 6 A minimum (pause instead), and a charger misconfigured as watts rejecting its cap. |
| `npm run reconnect-demo` | — · 9022 | ~20 s | **Reboots and reconnects.** A charger that reboots and forgets its profile, or drops its connection, gets its cap re-sent; a cap changed while it was offline is the one it gets back. |
| `npm run sim-reconnect-demo` | — · 9060 | ~15 s | **The simulated charger's auto-reconnect** (on in `npm run charger-sim`): the OCPP server stops for 3 s and a new one starts; sims with auto-reconnect come back by themselves with their cap, one without stays offline, and an intentional reconnect still gives one meter stream. |
| `npm run config-test` | — | ~1 s | **Config loader.** Both example configs load; defaults and per-charger overrides apply; the MQTT password comes from `BRIDGE_MQTT_PASSWORD` and charger passwords from their `passwordEnv` (unset variable, wrong length, trailing newline, a password in the file or in `chargerDefaults` rejected; mixed, shared and 40-hex passwords warned about); `siteMeter` defaults and bad values; warnings for a missing `fallbackImportLimitW`, a missing `siteMeter` and amps chargers below 253 V; typos, bad values, duplicate ids, a password in the file and a missing file are rejected, with every problem reported at once. |
| `npm run runtime-demo` | 8110 · 9031 | ~25 s | **The real program.** Runs `src/main.ts` as its own process from a config file, like `npm start` and Docker do. A bad config exits 2 with a clear message; against a mock server (5 kW default, 3 kW control for 8 s) a simulated charger goes 5000 → 3000 → 5000 W; an unknown charger id is refused (HTTP 404) with a warning; every log line has a timestamp, level and component; on SIGTERM it exits 0 and the charger keeps its last cap (on Windows, which can't send signals, the same shutdown is triggered by an IPC message). |
| `npm run sp1-demo` | 8120 · 9040 | ~3 s | **Charger passwords (OCPP Security Profile 1).** Runs `src/main.ts` with CP1's password in an environment variable (`passwordEnv`) and CP2 without one. A too-short password stops start-up (exit 2) without printing it; CP1 with no password or a wrong one (shorter, and same length) is refused with HTTP 401, logged once a minute rather than on every try; an unconfigured id is still refused with 404; CP1 with the right password connects and both chargers get 2500 W; start-up warns that CP2 has no password; no password, or its base64, appears anywhere in the output. |

`npm run ode-live` runs the chain with the **real** Open Dynamic Export (ports 8130–8132 · 9050): `-- --ode-dir <ODE checkout>` on one machine, or `-- --compose` against `docker compose up` (the CI `docker` job runs this one). A fake meter tells ODE the house uses 500 W, the bridge reads that from ODE's REST API, and the charger follows 4500 → 2500 → 4500 W. Details: [`plans/notes/ode-live.md`](../plans/notes/ode-live.md).

`npm run mock-csip` is not a test: it serves a mock CSIP-AUS server on port 8080 until you stop it (5 kW default, a 3 kW control from 10 s to 40 s), so you can browse `http://localhost:8080/dcap` or point a client at it.

## Try the bridge by hand

`npm start` runs the real bridge from a config file; `npm run charger-sim` runs one simulated charger on its own. Three terminals:

```bash
npm run mock-csip
```

```bash
npm start -- --config config.example.mock-csip.json
```

```bash
npm run charger-sim -- --url ws://localhost:9030/CP1
```

Expect the charger terminal to show `drawing 5000 W`, then `drawing 3000 W` about 10 s after `mock-csip` started, then `drawing 5000 W` again 30 s later. Ctrl+C the bridge: it logs `leaving the chargers' last caps in place` and the charger stays at its last cap. `charger-sim` also takes `--protocol 1.6`, `--phases 3`, `--amps-only`, `--max-w`, `--min-amps` and `--voltage`; it waits for the bridge if it isn't up yet, and if the bridge restarts it keeps its cap and reconnects by itself (1 s backoff, growing to 10 s; `--no-reconnect` turns that off).

## What the tests don't cover

- Real network servers. The bridge's own CSIP-AUS client has no TLS or certificates; with ODE, TLS is tested only against our mock server and public test certificates.
- Real chargers. Every charger in every test is our simulator, so real firmware quirks (OCPP 1.6J or 2.0.1) are untested.
- Booting while the network server is unreachable (handled in code, not tested).
- Long runs: the demos last about a minute each.
- The arm64 (Raspberry Pi) Docker image: CI builds and runs the amd64 image only.

## Adding a demo

1. Give it its own ports (see the table, and the port ranges in the v0.1 plan).
2. Make it check its own result and `process.exit(1)` on failure.
3. Add it to `package.json` scripts, to the table above, and as a step in `.github/workflows/ci.yml`.
4. It should pass 3 runs in a row before it goes in.
