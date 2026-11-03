# Site meter in the installed program (2 Nov 2026)

Written by Claude; Zach reviews. Chargers now get `limit − house load` from the real program, reading the meter already configured in ODE. Run: `npm run site-meter-demo`; config: `siteMeter` in `docs/configuration.md`.

## Source: ODE's REST API, not MQTT, not Modbus

Checked against ODE `v0.20.0` = commit `bc807ab` (the version `docker-compose.yml` pins).

- **MQTT: no site data.** `src/coordinator/helpers/publish.ts:33-66` publishes only `onActiveInverterControlLimit` and `onCsipAus`: limits, no samples.
- **REST: yes.** `GET /api/coordinator/status` (`src/server/controllers/coordinatorController.ts:5,13-17`) returns `siteSample: this.coordinator.siteSamplePoller.getSiteSampleCache` (`src/server/services/coordinatorService.ts:49`), typed at `:139-172`. No auth (ODE's `src/app.ts` adds none). `/api/data/siteRealPower` also exists but reads InfluxDB (`dataService.ts:13`), which the compose stack doesn't run, so not that one.
- **Why not Modbus (b):** the installer already set the meter up in ODE, and ★ meters often allow few Modbus TCP connections (general knowledge, not checked per model), so two clients on one meter is a new way to break ODE's solar control. It's also much more code (`modbus-serial`, SunSpec discovery, scale factors, per-brand quirks) for no gain while we need ODE anyway. **TODO:** only worth building for a site without ODE; ODE's `src/meters/sunspec/` is the model.
- **Why not a change to ODE:** publishing `siteSample` over MQTT would be cleaner (push, no polling). Worth asking in the EV proposal; until it's released we can't rely on it. Not added to `upstream/ode-ev-proposal-draft.md`: Zach's call.

### Traps in ODE's data

1. **A dead meter doesn't look dead.** On a failed read the cache keeps the old sample (`src/meters/siteSamplePollerBase.ts:87-93`). So a sample only counts if its `date` changed. Comparing dates with each other, not with our clock, means a different clock on another box doesn't matter. The first sample only sets the baseline.
2. **Except ODE's `mqtt` meter:** `src/meters/mqtt/index.ts:56` stamps `new Date()` on the cached message at every read, so a dead MQTT meter looks alive to us (and to ODE). Documented as a blind spot. `sunspec` (`src/meters/sunspec/index.ts:83`), `sma` and `powerwall2` set the date when they read. This also means `ode-live` can't test the frozen case; `site-meter-demo` fakes it.
3. **A sample is older than the fetch.** ODE reads every 200 ms by default (`configSchema.ts`), and Bridge must not use a site reading from before the chargers settled: when raising a cap, an old site reading with a new charger reading makes the house look too small. So a reading is stamped `fetch start − 1 s` (`SAMPLE_MAX_AGE_MS`). Assumes ODE's `pollingIntervalMs` stays under ~1 s.

## Sign convention: checked

ODE: positive = import, negative = export (`src/meters/siteSample.ts:11-15`, `docs/configuration/meter.md:33-35`). Same as `Bridge` and `SimSiteMeter`, so no conversion. `feedin` SunSpec meters pass `W` straight through (`src/meters/sunspec/index.ts:66-67,90`); `consumption` ones are converted by ODE (`:139-171`). Powerwall's `instant_power` and SMA's `W_phs*` also go straight through. ★ I checked ODE's code and docs, not a physical meter. An installer's CT clamped backwards would be wrong for ODE too, so the example config says to check it on ODE's dashboard.

## Meter silent: kept 0 W, shortened 60 s → 15 s, now configurable

`silentAfterMs`, default 15 s. Keep 0 W: the house could be using anything, and 0 W is the only share that can't break the limit. A pause is cheap (cars resume); a breach isn't. 60 s was too long: an oven switched on stays unseen for a minute. ODE reads at 5 Hz, so 15 s of nothing isn't a blip. A restart of ODE does pause charging, and that's the cost. ★ Not checked against any network's rule.

Age is now taken from the **latest meter reading**, not the estimate. Otherwise waiting for a charger's report would count as a silent meter. `SITE METER SILENT` is logged once at the change; a boot without a reading stays quiet until the silent time has passed.

## Two bridge bugs this exposed (fixed)

The old logic was only ever run with sims reporting every second. On real chargers:

1. **Stale readings used forever.** `updateHouseLoad` checked "reading after settle → use it" before the idle check, so a charger that stopped reporting (car unplugged) kept its last draw indefinitely. The house looked smaller and other chargers got too much: **over the limit**, contradicting the comment. Fixed: idle or offline first.
2. **Oscillation with slow meters.** With a 5 s idle limit, a charger reporting every 60 s: reading before the change and >5 s old → counted as 0 W → its draw counted as house → share cut → site drops → share raised → repeat, until its next report. Fixed by (a) `chargerIdleAfterMs` default 15 s, configurable, and (b) asking for 5 s reports.

## New: asking chargers to report power

`Manager` option `powerReportIntervalS`, on when a site meter is set. On boot or connect: 1.6 `ChangeConfiguration` (`MeterValueSampleInterval`, `MeterValuesSampledData`), 2.0.1 `SetVariables` (`SampledDataCtrlr.TxUpdatedInterval`, `TxUpdatedMeasurands`). A refusal is logged as a warning. The sim obeys, so the demos run with 5 s reports. ★ Key names are from memory of the specs: check against the OCA PDFs. Never tried on real firmware; ★ I don't know how many chargers accept 5 s.

## Real-world limits (blunt)

- **A charger that won't report `Power.Active.Import` will flap:** its draw looks like house load, so it's cut, then raised, every couple of seconds. Safe for the limit, bad for the car. Only a warning at start-up. **First thing to test on a real charger.** TODO: detect it (limit changes repeatedly, no readings), or fall back to `Current.Import` × voltage.
- **While waiting for a slow charger's report the estimate is held**, so a kettle in that window is unseen for up to one report interval (up to `chargerIdleAfterMs`).
- **A stopped car counts as its last reading for up to `chargerIdleAfterMs`.** Others can get too much for up to 15 s. TODO: on `StopTransaction` / `TransactionEvent` Ended, or `StatusNotification` Available, record 0 W at once.
- `SETTLE_MS` (300 ms) assumes a charger obeys at once. Real ones ramp over seconds, so the house estimate will wobble around each change. Hysteresis only smooths raises. Measure on real hardware.
- Shares don't account for a charger's 6 A minimum: 2 chargers with 2 kW left get 1 kW each, both paused, 2 kW wasted (already a known gap).
- 1 Hz REST polling of the status endpoint on a Pi: untested, but ODE's own dashboard polls it at the same rate (`src/ui/routes/index.tsx:22-25`).

## Tests

- `npm run site-meter-demo` (8150 MQTT, 8151 REST, 9070 OCPP; ~60 s, new, in CI): `main.ts` as a process, fake ODE at the protocol level. See `docs/testing.md`.
- `npm run ode-live`: bridge config now has `siteMeter`. **Real ODE PASS locally** (charger `[7400, 0, 4500, 2500, 4500]` W with a 500 W house), which proves the REST path and response shape against real ODE. The fake meter publishes at 5 Hz. `--compose` uses `ci/bridge.config.json` (also updated) but **hasn't run yet**: no Docker here, and CI only runs once this branch is pushed.
- `npm run config-test`: `siteMeter` defaults, errors, the missing-meter warning.
- Gotcha: ODE's install fails to run from a very long path on Windows (esbuild.exe ENOENT, path over 260 chars). Clone it somewhere short.

## Changes outside the obvious files

`src/csms.ts` (`requestPowerReports`, `powerReportIntervalS`), `src/chargerSim.ts` (handles `ChangeConfiguration` / `SetVariables`), `src/log.ts` (`SILENT` is a warning), `src/bridge.ts` (see above; `HOUSE_ESTIMATE_MAX_AGE_MS` and `CHARGER_IDLE_AFTER_MS` became options).

**For CLAUDE.md (main tab):** section 6a's "No site meter in `main.ts`" is done; section 7 needs `odeSiteMeter.ts` and `runOdeSiteMeter.ts`; the week-5 bullet's "No house estimate (no reading, or >60 s old)" and "no reading for 5 s" are now 15 s and configurable.
