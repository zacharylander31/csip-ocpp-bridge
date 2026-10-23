# Tab A: ODE input (notes for merging into CLAUDE.md)

Branch `claude/tab-a-ode-input-9f4265`, 23 Oct 2026. Written by Claude; Zach reviews.

## What I built

| File | What it does |
|---|---|
| `src/limitSource.ts` | `ActiveLimit` (moved here from csipClient.ts) and the `LimitSource` interface: `refresh()`, `lastUpdatedAt`, optional `commsLostAfterMs`, `activeImportLimit()`, `defaultImportLimit()`. **Committed on its own first (ce06370) for Tab C.** |
| `src/odeMqttSource.ts` | `OdeMqttSource`: subscribes to ODE's `<topic>/csipAus` over MQTT, checks every message, learns the default, and reports the limit. `start()`/`stop()` connect and disconnect. `parseOdeCsipAusMessage()` is exported for tests. |
| `src/runOdeMqtt.ts` | `npm run ode-demo` (ports 8090 MQTT, 9010 OCPP). In-process `aedes` broker + a fake ODE publishing every second: default 5 kW → 3 kW control → bad messages mixed in → only bad messages → broker down → fail-safe default → broker up → control again → control ends. Two sim chargers. Expects shares 2500, 1500, 2500 (fail-safe), 1500, 2500 each; checks readings strictly after each ack. ~42 s. |
| `src/bridge.ts` | Takes a `LimitSource` instead of `CsipClient` (details below). |

Results: `npm run typecheck` passes. `ode-demo` PASS **5/5 in a row** alone, plus PASS alongside all the other demos in parallel. All the other demos pass, but `npm run demo` is flaky, and that's pre-existing (see "Found along the way").

## ODE's MQTT output (checked against commit `bc807ab`, 16 Jul 2026)

**Config** (`src/helpers/configSchema.ts:353-387`, docs `docs/configuration/publish.md`):
```jsonc
"publish": { "mqtt": {
    "host": "mqtt://192.168.1.2",   // required, includes mqtt://
    "username": "...", "password": "...",  // optional
    "topic": "limits",              // required
    "csipAus": "limits/csipAus"     // optional, defaults to "<topic>/csipAus"
} }
```
`src/coordinator/helpers/publish.ts:18-31` connects with `mqtt.connect(host, {username, password})` and sets the two topics (`:25-28`).

**Topic 1: `<topic>`: active limits.** `publish.ts:33-46` publishes `JSON.stringify(limit)` of `ActiveInverterControlLimit` (`src/coordinator/helpers/inverterController.ts:595-632`):
```json
{ "opModEnergize": {"value": true, "source": "csipAus"},
  "opModConnect":  {"value": true, "source": "csipAus"},
  "opModExpLimW":  {"value": 1500, "source": "csipAus"},
  "opModImpLimW":  {"value": 3000, "source": "csipAus"} }
```
- Each field is `{value, source}` or **missing** (it's `undefined` and `JSON.stringify` drops it). Missing = no limit.
- `source` ∈ `fixed | mqtt | csipAus | twoWayTariff | negativeFeedIn | batteryChargeBuffer` (`inverterController.ts:37-43`).
- It **merges all of ODE's setpoints**: for `opModImpLimW` the lowest value wins (`getActiveInverterControlLimit`, `inverterController.ts:634`, import at `:703-713`). It can't tell a CSIP-AUS control from the default.

**Topic 2: `<topic>/csipAus`: CSIP-AUS only.** `publish.ts:48-66` publishes `{limit, setGradW, schedules}`:
```jsonc
{ "limit": { "source": "csipAus", "opModEnergize": true, "opModConnect": true,
             "opModGenLimW": 5000, "opModExpLimW": 5000, "opModImpLimW": 3000 /* or missing */,
             "opModLoadLimW": /* missing */ },
  "setGradW": 27,   // DERSettings ramp rate, hundredths of a percent per second
  "schedules": {
    "opModImpLimW": [ { "mRID": "...", "startInclusive": "<ISO>", "endExclusive": "<ISO>",
                        "effectiveStartInclusive": "<ISO>", "effectiveEndExclusive": "<ISO>",
                        "randomizeStart": /* missing or s */, "randomizeDuration": /* ... */,
                        "derControlBase": { "opModImpLimW": { "value": 3, "multiplier": 3 } },
                        "responseRequired": "03", "replyToHref": "..." } ],
    "opModExpLimW": [], "opModGenLimW": [], "opModLoadLimW": [], "opModEnergize": [], "opModConnect": [] } }
```
- `limit` is `InverterControlLimit` (`inverterController.ts:45-53`): **plain numbers in W** (already multiplied out with `numberWithPow10`), not `{value, source}`.
- `limit.opModImpLimW` is ODE's resolved answer: active control → else the default control (DefaultDERControl) → else ODE's `fixedDefault.importLimitWatts` config (`src/setpoints/csipAus/index.ts:392-424`, `case 'none'` at `:417-423`). It's **ramped** (`ControlLimitRampHelper`, `:456`, using rampTms or setGradW), so it can move gradually between values.
- `schedules.opModImpLimW` lists active and upcoming controls that set an import limit (`controlScheduler.ts:82-84`, `:96`). Dates are `Date`s, so ISO strings in UTC. `effective*` include ODE's randomisation (`controlScheduler.ts:33-36`).
- **The default control is not published anywhere on its own.**
- Only published if ODE has the csipAus setpoint configured (`inverterController.ts:187-193`).

**How often:** both topics, every run of `updateControlLimitsLoop`, "at most every 1 second" (`inverterController.ts:210-215`), i.e. about 1/s. **Not retained**, and sent even when nothing changed (`docs/configuration/publish.md:16-17`). QoS 0 (mqtt.js default).

**Not published:** whether ODE is still talking to the network. ODE tracks a `connected` flag from failed dcap polls (`src/setpoints/csipAus/index.ts:283-285`, `:557`) but only shows it on the REST status API.

## Decisions (plain words)

1. **Subscribe to `<topic>/csipAus`, not the main topic.** The main topic can't tell a control from the default, so we couldn't do the fail-safe. The csipAus topic has the schedules, which tell us when a control is active. Downside: limits from ODE's other setpoints (e.g. a `fixed` import limit the installer set) are ignored. That's fine for EV import limits for now; see TODO.
2. **Use ODE's `limit.opModImpLimW` as the current limit; don't redo the scheduling.** ODE already handles randomisation, superseded controls and ramping. We only use the schedules to label the limit (control + mRID, or default).
3. **Learn the default.** When no control starts or ends within 5 s of now, the limit ODE sends *is* the default (or ODE's fixedDefault), so we remember it. The 5 s margin covers clock differences and ramping near boundaries. If we never saw a default (we started mid-control), `fallbackImportLimitW` from the config is used. Without one there's no default, and caps are removed on comms loss, same as CsipClient without a default.
4. **One fail-safe, in the bridge, for both sources.** The bridge already had it; now it reads `source.lastUpdatedAt` instead of its own "last good poll". OdeMqttSource sets `lastUpdatedAt` on every *valid* message, so a bad message doesn't keep the link "alive". `commsLostAfterMs` defaults to 10 s for ODE (10 missed messages) via the interface's optional `commsLostAfterMs`; the bridge's own option still wins.
5. **`refresh()` for a push source** only checks that messages are still arriving (it throws if not, so the bridge logs "poll failed"). At boot it waits up to 3 s for the first message, since nothing is retained, so the bridge starts with a real limit.
6. **Validation, strict on what we use:** must be JSON and an object; `limit` must be an object; `limit.opModImpLimW` must be missing or a finite number ≥ 0 (`null` is rejected: ODE never sends it); `schedules.opModImpLimW` must be an array whose entries have a string `mRID` and valid ISO effective start/end, with end ≥ start. Anything else in the message is ignored, so ODE adding fields won't break us. Bad messages are counted (`rejectedMessages`) and logged at most once per 30 s.
7. **Telemetry stays CsipClient-only.** The bridge runs its telemetry loop only if the source is a `CsipClient` (`instanceof`), so existing demos didn't need changing. With ODE in front, ODE reports to the network.
8. **Dependencies:** `mqtt` ^5.16.1 (ODE uses ^5.14.1), and dev dependency `aedes` ^1.2.0 (in-process broker for the demo). mqtt.js reconnects every 1 s; we subscribe again on every `connect` (`resubscribe: false`, so it happens in one place).

## Changes outside Tab A's files

- `src/csipClient.ts` (needed for "make CsipClient satisfy it"): `implements LimitSource`; `ActiveLimit` moved to limitSource.ts and re-exported (so `checkCsipClient.ts` is unchanged); new `refresh()` (runs `discover()` until it has worked once, then `poll()`); new `lastUpdatedAt` (set at the end of a good `poll()`). Existing methods are unchanged.
- `src/bridge.ts` (minimal change; Tab A owns it): constructor takes `source: LimitSource`; removed `discovered`/`lastGoodPollAt`; telemetry methods take the `CsipClient` as a parameter. Small behaviour change: telemetry now waits for the first good *poll* (previously the first good *discover*). That's more correct, since telemetry needs the server clock from a poll.
- `package.json`: script `ode-demo`; dependencies `mqtt`, `aedes` (dev). `package-lock.json`: also npm synced its `license` field from MIT to Apache-2.0 (package.json already said Apache-2.0).

## Found along the way (not fixed: other tabs' files)

- **`npm run demo` (week 3) is flaky: about 1 run in 3–5 fails, even alone and on the base commit 43d1fbf** (I checked with an untouched copy: 1/5 failed). Pattern: `capped=7400,3000,...`, i.e. a reading stamped at or after the ack still shows the old power. Cause: the sim computes power *before* `client.call('TransactionEvent')` (`chargerSim.ts:107-110`), which ocpp-rpc can queue behind an earlier call, while the SetChargingProfile *reply* goes straight out. The CSMS stamps readings on receipt (`csms.ts:110`). Also, a reading in the same millisecond as the ack passes `>=`. In ode-demo I use `> ackedAt` (that fixed its 1-in-4 failure, then 5/5 passed). **For Tab B** (owns chargerSim/csms/runDemo): use `>` in runDemo/runBridge, or have the sim stamp each reading with when it was measured (OCPP `meterValue.timestamp`) and check by that. **For Tab D**: CI will flake on `demo` until then.
- **ODE doesn't fail safe itself.** When it can't reach the network server, it only clears its `connected` flag and keeps following its cached schedule/default. So "MQTT silent" in our bridge means *ODE or the broker* is gone, not that the network is unreachable. Worth raising in the ODE EV proposal (and checking against CSIP-AUS comms-loss rules).

## TODOs

- Decide whether to also honour ODE's main topic (`opModImpLimW` from `fixed`/`mqtt` setpoints), e.g. take the lower of the two. Needs a rule for which one's default to use on silence.
- Persist the learned default to disk, so a restart during a control still has the right default (until then, `fallbackImportLimitW` covers it). Tab C: expose `fallbackImportLimitW` in the config and recommend setting it.
- `opModLoadLimW`, `opModEnergize`/`opModConnect` (de-energise/disconnect) are ignored. Chargers should probably pause on `opModConnect: false`.
- ODE ramps the limit, so a ramp down from 5 kW to 3 kW arrives as several steps. The bridge sends each lower share at once (more SetChargingProfile calls, still correct). Check with a real ODE.
- MQTT TLS (`mqtts://`) and client certs: not tested; mqtt.js supports them via options if needed.
- Tested only against my fake ODE, built from ODE's source and docs. **Run against a real ODE** (its mock SEP2 server) before v0.1.
- `refresh()` waits up to 3 s at boot; `Bridge.stop()` can take up to 3 s if called during that wait.
