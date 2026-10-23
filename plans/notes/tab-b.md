# Tab B notes: real-charger OCPP (23 Oct 2026)

Branch `claude/tab-b-ocpp-72854b`. Ports used: 9020–9022 (OCPP only, no HTTP).

## What I built

| File | Change |
|---|---|
| `src/csms.ts` | Accepts `ocpp2.0.1` and `ocpp1.6` (2.0.1 preferred if a charger offers both). One `ManagedCharger` API for both versions: `capPower(W)`, `removeCap()`, `readings`, plus new `version`, `connected`, `compliant`, `compliantSince`, `lastCap`, `config`. New pure functions `planCap()` (W → limit to send) and `totalPowerW()` (meter samples → total W). `Manager` takes an optional second argument `{ defaults, chargers: { [id]: ChargerConfig }, bootWaitMs }`. |
| `src/chargerSim.ts` | Options `protocol: '1.6'`, `acceptsW: false` (amps-only, rejects W profiles), `phases: 3` (amps are per phase; reports power per phase, no total), `voltage`, `evMinAmpsPerPhase` (car stops below it). Actions `reboot()` (drops connection, forgets profiles, boots, new transaction) and `reconnect()` (drops connection only; keeps profiles; no boot). |
| `src/runOcpp16.ts` | `npm run ocpp16-demo` (port 9020): a 1.6 and a 2.0.1 charger on one manager, both 7400 → 3000 → 7400 W. |
| `src/runAmps.ts` | `npm run amps-demo` (9021): 11 `planCap` cases, then four amps-only chargers: 1-phase 13 A = 2990 W; 3-phase paused at 3 kW (below 6 A × 3); what happens *without* the minimum (car stops but we think it may draw 2760 W); a charger misconfigured as W is Rejected; 21 A / 7 A × 3 = 4830 W; caps removed. |
| `src/runReconnect.ts` | `npm run reconnect-demo` (9022): reboot → cap re-sent after boot → compliant; network blip (no boot) → re-sent after the boot wait, never went over; cap changed while offline → `capPower` throws, new cap applied on return; no cap + reboot → clear re-sent, full power. |

All three pass 3/3. `npm run typecheck` passes. Existing demos (`demo`, `check-csip`, `bridge-demo`, `failsafe-demo`, `telemetry-demo`, `site-demo`) all pass after the change.

## Key decisions (plain words)

1. **One `ManagedCharger` per charger id, for the whole run.** Before, a reconnecting charger got a brand-new object and Bridge's reference went stale. Now Manager keeps the object and swaps its connection (`attach`/`detach`). `Manager.chargers` now also holds offline chargers (check `connected`).
2. **The charger object remembers what Bridge last asked for** (`wanted`) and re-sends it after a reconnect. Bridge only sends on a *change*, so without this a rebooted charger would sit uncapped until the network limit changed.
3. **When to re-send:** right after the charger's BootNotification is accepted (after our reply is on the wire: a charger may refuse commands before boot is accepted), or after `bootWaitMs` (2 s) if it doesn't boot, which means it only lost its network. Gap measured in the demo: ~20 ms after a reboot.
4. **`compliant`** = connected and has accepted the latest request *on this connection*. False from disconnect until the re-send is accepted. `compliantSince` is when that happened; only readings after it (plus a margin, see gotcha) reflect the cap.
5. **Sends are queued per charger**, so a re-send and a new cap from Bridge can't overtake each other; whatever was asked for last lands last.
6. **`capPower` while offline throws** (Bridge already logs and retries), but the new cap is remembered and sent on reconnect. I didn't return a fake "Accepted": Bridge would record a cap that hasn't been applied.
7. **Amps:** `watts / (voltage × phases)`, rounded **down** to `ampStep`. Watts are rounded down to whole W. A charger is never allowed more than its share. `numberPhases` is sent with amps limits because both versions assume 3 phases if it's missing.
8. **`ampStep` defaults to 1 A, not 0.1 A.** Found by testing: OCPP 1.6's schema says `limit` is `multipleOf: 0.1`, and in JavaScript `6.3 / 0.1 = 62.99999999999999`, so ocpp-rpc's strict mode refuses to send 6.3 A (also 6.1, 0.3...). Real chargers' validators may do the same. 2.0.1 has no `multipleOf`, so 0.1 A works there if configured.
9. **Minimum current, default 6 A per phase** (IEC 61851). Below it the cap is sent as **0** (pause), `lastCap.paused = true`, `lastCap.allowedW = 0`. Applies to W chargers too (6 A × 230 V = 1380 W single phase, **4140 W three phase**). Bridge can read `lastCap.allowedW` to give the unused share to other chargers (not done yet: Tab A / phase 2).
10. **Config is set, not read from the charger** (see TODO). Default: W, 1 phase, 230 V, 1 A step, 6 A min. This keeps the existing demos behaving the same, except site-demo (below).
11. **Meter readings:** a total `Power.Active.Import` (no phase) if there is one, else the sum of L1/L2/L3 (or L1-N…). `kW` → ×1000; 2.0.1 `unitOfMeasure.multiplier` applied. 1.6 values are strings. 2.0.1 reads both `TransactionEvent` and `MeterValues`.
12. **Authorize / StartTransaction accept every ID tag.** On a home site the bridge *is* the charger's CSMS, so it has to answer these.

## Gotcha found (affects Bridge and the existing demos too)

**"Only readings received after the charger's reply reflect the new limit" is not quite true.** The ocpp-rpc server can run the handler for a meter reading that arrived just *before* the reply a moment *after* the reply's promise resolves (seen: same millisecond, stale 7400 W after a 3000 W ack). It showed up because the sims' meter timers and the demo's sleeps lined up. My demos skip 300 ms after the ack (`SETTLE_MS`). The existing demos and `bridge.ts` (`lastChangeAt`) use the strict rule; they passed, but could flake the same way. Suggest Tab A / main adds a small margin.

## Changed outside my files

- `src/runSiteMeter.ts`, one line: `new Manager(() => {}, { defaults: { minAmpsPerPhase: 0 } })`. Its 1000 W per-charger shares are below the new 6 A minimum, so without this they'd be paused and the demo's expected values would fail. (Its result is now physically unrealistic; worth revisiting when Bridge reallocates paused shares.)
- `package.json`: scripts `ocpp16-demo`, `amps-demo`, `reconnect-demo`. No new dependencies.
- `Manager.chargers` keeps offline chargers; `waitForCharger` resolves on the next connect. No current caller depends on the old behaviour.

## TODOs

- **Bridge (Tab A / main):** use `charger.compliant` instead of only its own `appliedW`; use `lastCap.paused` / `allowedW` to reallocate; a paused charger's share is currently wasted.
- **Read the charger's capabilities instead of configuring them:** 1.6 `GetConfiguration` key `ChargingScheduleAllowedChargingRateUnit` ("Current", "Power"); 2.0.1 `GetVariables` `SmartChargingCtrlr.RateUnit`. Also 1.6 `ChargeProfileMaxStackLevel`, `ChargingScheduleMaxPeriods`.
- **Some 1.6 chargers don't support `ChargePointMaxProfile`** (only `TxDefaultProfile`/`TxProfile`). Fallback: `TxDefaultProfile` on connector 0. Needs a real charger to confirm.
- **Three-phase chargers that can switch to one phase** (2.0.1 `ACPhaseSwitchingSupported`, `numberPhases: 1`): would let a 3-phase charger keep charging at 1380–4140 W instead of pausing.
- **Actual voltage (safety issue for amps chargers):** Australian supply often sits at 240–250 V. We convert W → A at the configured 230 V, but the car draws A × the *real* voltage, so at 245 V an amps cap lets it draw ~6.5% more than its share (13 A: 2990 W planned, 3185 W real). Fix before real chargers: configure 253 V (the AS 60038 upper limit) or use the charger's measured `Voltage` readings. W-unit chargers aren't affected.
- Re-send after reconnect also when `wanted` hasn't changed but the charger reports profiles via `GetChargingProfiles` (2.0.1) / `GetCompositeSchedule` (1.6), to verify rather than trust.
- OCPP security profiles (TLS, basic auth) — not started.
- Charger timers: stale-reading margin should probably live in csms.ts (e.g. `compliantSince + margin`) rather than every caller.

## Spec sections relied on

OCPP 1.6 (Edition 2):
- 3.13 Smart Charging: profile purposes (ChargePointMaxProfile on connectorId 0 = whole charge point), stacking, `numberPhases` default 3.
- 4.2 BootNotification, 4.7 MeterValues, 4.8 StartTransaction (CSMS assigns the integer transactionId), 4.9 StatusNotification, 4.10 StopTransaction, 4.1 Authorize.
- 5.5 ClearChargingProfile (field `id`; Accepted / Unknown), 5.16 SetChargingProfile (`connectorId`, `csChargingProfiles`; Accepted / Rejected / NotSupported).
- 7.x types: ChargingSchedule / ChargingSchedulePeriod (`limit` multipleOf 0.1), SampledValue (value is a string; default measurand Energy.Active.Import.Register; `phase`, `unit` W/kW).
- 9.1/9.4 configuration keys mentioned in TODOs.
- JSON schemas as shipped in ocpp-rpc 2.2.1 (`lib/schemas/ocpp1_6.json`) — these are what strict mode actually enforces.

OCPP 2.0.1:
- B01 Cold Boot (CSMS shouldn't send requests before boot is Accepted — why the re-send waits for boot).
- K01 SetChargingProfile (ChargingStationMaxProfile on evseId 0), K10 ClearChargingProfile.
- E02 / J02 meter values inside TransactionEvent during a transaction; J01 standalone MeterValues outside one.
- ChargingSchedulePeriodType: `numberPhases` (default 3), `phaseToUse`; SampledValueType / UnitOfMeasureType (`multiplier`).
- Not verified against the PDF: whether stored profiles must survive a reboot. We re-send regardless, since it's harmless (same profile id replaces the old one).
