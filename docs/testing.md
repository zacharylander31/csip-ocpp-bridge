# Testing

Every demo starts its own mock CSIP-AUS server and simulated chargers, checks the result, prints `PASS` or `FAIL`, and **exits non-zero on failure**. CI runs all of them on every push and pull request ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

```bash
npm ci
npm run typecheck
npm run demo
```

Each demo uses its own ports, so they can also run side by side.

| Command | Ports (CSIP · OCPP) | Takes | What it proves |
|---|---|---|---|
| `npm run typecheck` | — | seconds | The TypeScript compiles with no type errors. |
| `npm run demo` | — · 9000 | ~15 s | **OCPP only.** One simulated charger draws 7.4 kW, obeys a 3 kW `SetChargingProfile`, and goes back to 7.4 kW after `ClearChargingProfile`. Checked from the charger's own meter values. |
| `npm run check-csip` | 8081 · — | ~10 s | **CSIP-AUS client only.** Picks the right limit as time passes (default → control → default) without re-polling; handles the `ns2` namespace prefix; uses the server's clock when it is an hour off; reports no limit when there's no default control (404). |
| `npm run bridge-demo` | 8082 · 9001 | ~20 s | **End to end.** Site default 5 kW → 3 kW control for 8 s → default. Two chargers each draw 2500 → 1500 → 2500 W. Checks each charger's readings between each acknowledgement and its next command. |
| `npm run failsafe-demo` | 8083 · 9002 | ~25 s | **Comms loss.** One charger: 5 kW default → 3 kW control → link down → after 3 s with no good poll (3 polls) the default 5 kW applies → link up → back to 3 kW → control ends → 5 kW. |
| `npm run telemetry-demo` | 8084 · 9003 | ~40 s | **Telemetry.** Two chargers, 5 kW → 3 kW for 15 s → 5 kW, posted every 5 s. Checks each interval's value, that every interval arrives in order with no gaps, and that the bridge re-registers when the server forgets its mirror. |
| `npm run site-demo` | 8085 · 9004 | ~35 s | **Site meter.** House load changes (kettle, solar export) and a 3 kW control. Chargers get `limit − house`: 2000, 1000, 2000, 1000, 2200, 3200 W each. The site goes over the limit only within 3 s of a change, and site telemetry matches. |

`npm run mock-csip` is not a test: it serves a mock CSIP-AUS server on port 8080 until you stop it (5 kW default, a 3 kW control from 10 s to 40 s), so you can browse `http://localhost:8080/dcap` or point a client at it.

## What the tests don't cover

- Real network servers, TLS and certificates.
- Real chargers (OCPP 1.6J and real 2.0.1 firmware are planned for v0.1).
- Booting while the network server is unreachable (handled in code, not tested).
- Long runs: the demos last under a minute each.

## Adding a demo

1. Give it its own ports (see the table, and the port ranges in the v0.1 plan).
2. Make it check its own result and `process.exit(1)` on failure.
3. Add it to `package.json` scripts, to the table above, and as a step in `.github/workflows/ci.yml`.
4. It should pass 3 runs in a row before it goes in.
