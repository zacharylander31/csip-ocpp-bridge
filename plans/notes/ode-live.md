# Real ODE in the loop (28 Oct 2026)

Goal: prove the chain with the **real** Open Dynamic Export, not our fake one:

    mock network (HTTPS) --CSIP-AUS--> ODE v0.20.0 --MQTT--> broker --> bridge (main.ts) --OCPP--> sim charger

## What was built

- `npm run ode-live -- --ode-dir <ODE checkout>` (`src/runOdeLive.ts`, ports 8130 HTTPS mock, 8131 MQTT, 8132 ODE, 9050 OCPP): runs everything as processes on one machine. **PASS 3/3** on Windows against ODE `v0.20.0` from source.
- `npm run ode-live -- --compose`: the same check against the Docker stack (`docker-compose.yml` + `ci/docker-compose.ci.yml`). Runs in CI (docker job). **PASS on the first CI run (40831681088, 29 Oct 2026)**: 5000 → 3000 → 5000 W, 57 telemetry readings. This PC has no Docker (virtualization off in BIOS, no WSL).
- Mock server (`src/mockCsipServer.ts`): optional HTTPS (`tls`), configurable gateway LFDI (`gatewayLfdi`, `lfdiOf(certPem)`), `GET /mup` (MirrorUsagePointList, ODE reads it), `POST /rsps/1/rsp` (DERControlResponse, ODE sends them), `setGradW` scenario option (default 27). Old callers unchanged.
- `npm run mock-csip` gained `--port --https --gateway-cert --control-in --control-for`.
- `test-certs/`: public self-signed TEST certs (ODE device + mock server). `.gitignore` has an exception for them only.

What the check asserts: charger capped at the 5 kW default; a 3 kW control the network adds while everything runs → 3 kW halfway through, never above 3 kW from 5 s in; back to 5 kW after; ODE registers mirrors and posts telemetry.

## Findings

1. **ODE ramps the import limit.** ODE ramps every limit at `setGradW` (hundredths of % per second) × the *inverters'* nameplate W, or over a control's `rampTms`. With SAPN's `setGradW 27` and a 5 kW inverter: 13.5 W/s, so 5 kW → 3 kW takes ~2.5 min, and a 20 s control barely moves the charger. With no inverter data ODE doesn't ramp at all. Question for the EV proposal: should an EV import limit ramp at a rate derived from the *solar inverter's* nameplate? (AS/NZS 4777.2 Wgra is about generation.) The live demo uses `setGradW 0` to test the plumbing.
2. **Bridge bug fixed:** `OdeMqttSource` learnt every ramped value as the network default (and logged a line every second). A comms loss mid-ramp would have fallen back to a number the network never sent. Now a value is learnt only after it has held for 5 s (`DEFAULT_STABLE_MS`) with no control within 5 s. `ode-demo` timeline moved +6 s for this, and checks a 60 s ramp isn't learnt.
3. **ODE retries a failed first poll only after its default poll rate** (minutes). So ODE must start after the CSIP-AUS server is reachable, or it sits idle. On a real site that's a slow start after an internet outage at boot, not a hang. In CI the check starts first, then `compose up`.
4. **Issue #139 seen live:** every telemetry reading ODE posted carried the period that had just started (posted ~50 ms after its start). The demo prints this.
5. At boot, before ODE's first message, the bridge waits 10 s, logs `COMMS LOST`, and applies `fallbackImportLimitW` (1500 W here). ODE also publishes its own `fixedDefault` (1500 W) for a moment before it has read the network's default. Both are correct, but the `COMMS LOST` warning at every boot looks alarming. TODO: a boot-specific message ("no limit from ODE yet, using fallback").
6. Git Bash strips `TZ` from Windows programs (ODE refuses to start without it). The script passes ODE a minimal environment directly from Node. ODE logs its **entire environment** when its settings are invalid, so never hand it `process.env`.

## TODO / open

- The mock reads only each reading's value and period. ODE posts many reading kinds, so the demo shows just one example value.
- arm64 (Pi) image still untested.
- ODE clone in the scratchpad is checked out at `v0.20.0`. The #139 fix is on its branch `fix/mirror-reading-time-period` (and in `upstream/`).
