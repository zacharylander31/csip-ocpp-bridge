# Configuration reference

The bridge reads one config file at start-up. Start from an example:

- [`config.example.json`](../config.example.json): a real site, next to Open Dynamic Export (`ode-mqtt`).
- [`config.example.mock-csip.json`](../config.example.mock-csip.json): try it on one machine against `npm run mock-csip`.

## File location and format

- **Format:** JSON, with `//` and `/* */` comments allowed. JSON because Open Dynamic Export's config is JSON too (one format for an installer to learn), and it needs no parser library. Comments are stripped before parsing.
- **Where:** `./config.json` by default. Override with `--config <path>` (`npm start -- --config my.json`) or the `BRIDGE_CONFIG` environment variable. In Docker it's mounted at `/config/config.json`.
- **Check without starting:** `npm start -- --check`, or `docker compose run --rm bridge node dist/main.js --check`.
- **Secrets** never go in the file: config files get copied, pasted into bug reports and committed. They come from environment variables (in Docker: the `.env` file next to `docker-compose.yml`). The MQTT password is `BRIDGE_MQTT_PASSWORD`; each charger's password is in the variable its `passwordEnv` names. A `password` key in the file is an error.
- Changes need a restart (`docker compose restart bridge`).

## Options

### `limitSource`: where the site's import limit comes from

`type` picks one of two sources.

**`"type": "ode-mqtt"`**: follow Open Dynamic Export's MQTT output (real sites).

| Option | Type | Default | Required | What it does |
|---|---|---|---|---|
| `url` | string | — | yes | The MQTT broker ODE publishes to (ODE's `publish.mqtt.host`), e.g. `mqtt://mosquitto:1883`. `mqtt://`, `mqtts://`, `ws://` or `wss://`. |
| `topic` | string | — | yes | ODE's `publish.mqtt.topic`. The bridge reads `<topic>/csipAus`. |
| `csipAusTopic` | string | `<topic>/csipAus` | no | Only if ODE's `publish.mqtt.csipAus` is set to something else. |
| `username` | string | none | no | Broker login. The password comes from `BRIDGE_MQTT_PASSWORD`. |
| `commsLostAfterMs` | integer ≥ 2000 | 10000 | no | No valid message for this long = comms lost: the default limit applies. ODE publishes about once a second. |
| `fallbackImportLimitW` | number ≥ 0 | none | **recommended** | The import limit (W) used on comms loss if the bridge never saw the network's default (e.g. it started during a control). Use the import limit in your connection agreement, the same as ODE's `fixedDefault.importLimitWatts`. Without it, comms loss in that case removes the caps. A warning is logged if it's missing. |

**`"type": "csip"`**: the bridge's built-in CSIP-AUS client. **No TLS or certificates: for the mock server only.** A warning is logged if `url` is plain `http://` to anything but localhost.

| Option | Type | Default | Required | What it does |
|---|---|---|---|---|
| `url` | string | — | yes | Server base URL, e.g. `http://localhost:8080`. The client starts at `<url>/dcap` and follows links from there. |
| `pen` | string | `00000000` | no | IANA Private Enterprise Number as 8 upper-case hex digits (ends every mRID the client creates for telemetry). |

With `csip`, the bridge also posts charger telemetry back to the server. With `ode-mqtt` it doesn't: ODE talks to the network.

### `ocpp`: the server chargers connect to

| Option | Type | Default | Required | What it does |
|---|---|---|---|---|
| `port` | integer | 9000 | no | Chargers connect to `ws://<host>:<port>/<charger id>`. In Docker, keep it matching the `ports:` line in `docker-compose.yml`. |
| `bootWaitMs` | integer ≤ 60000 | 2000 | no | After a charger reconnects, how long to wait for a BootNotification before re-sending its cap anyway (it only lost its connection). |

Both OCPP 1.6J and 2.0.1 are always accepted.

### `chargerDefaults` and `chargers`

`chargers` is the list of chargers the bridge manages (at least one). The site limit is split equally between them. Each entry needs an `id`; every other setting falls back to `chargerDefaults`, then to the built-in default.

| Option | Type | Default | Where | What it does |
|---|---|---|---|---|
| `id` | string | — | `chargers` only, required | The charger's OCPP identity: the last part of its URL. 1–48 characters from `A-Z a-z 0-9 . _ ~ : @ \| * + -`. Must be unique. |
| `passwordEnv` | environment variable name | none | `chargers` only | OCPP Security Profile 1: the name of the environment variable holding this charger's password, e.g. `"BRIDGE_CP1_PASSWORD"`. The charger must then send that password (HTTP Basic auth, username = its id) or it's refused with HTTP 401. The password must be 16–40 printable ASCII characters with no spaces (OCPP's limits); letters, digits, `-` and `_` are safest. Start-up fails if the variable is unset or the password is invalid (the error never shows the password). Without `passwordEnv` the charger connects without a password. Not allowed in `chargerDefaults`: give each charger its own. See [install.md](install.md#charger-passwords-ocpp-security-profile-1), including why this is not encryption. |
| `rateUnit` | `"W"` or `"A"` | `"W"` | both | What the charger accepts in a charging profile. Many chargers only take amps. A charger that rejects every cap usually has this wrong. |
| `phases` | `1` or `3` | `1` | both | Phases wired to the charger. Amps limits are per phase. |
| `voltage` | number, 180–260 | 230 | both | Nominal volts per phase. Only decides whether a W charger's share is below the minimum current (`minAmpsPerPhase`). |
| `maxVoltage` | number, 180–260, ≥ `voltage` | 253 | both | The highest the supply can reach, per phase: W shares are turned into amps at this voltage. A car draws amps × the *real* voltage, and Australian supply often sits at 240–250 V; 253 V is the top of AS 60038 (230 V +10%), so an amps cap worked out at 253 V stays within the share at any legal voltage. The cost is a slightly lower cap (at 240 V real, about 5% under the share). **Leave it at 253**; a warning is logged for amps chargers below that. |
| `ampStep` | number, > 0 and ≤ 10 | 1 | both | Amps are rounded **down** to a multiple of this. 1 A is safe: OCPP 1.6's schema rejects values like 6.3 A (floating-point `multipleOf: 0.1`). |
| `minAmpsPerPhase` | number, 0–32 | 6 | both | Below this a car stops charging (IEC 61851), so a smaller share is sent as 0 (pause). That's 1380 W single-phase, 4140 W three-phase at 230 V. 0 = no minimum. |

Chargers not in the list are **refused** at the handshake (HTTP 404) and logged as `REJECTED charger "<id>"`, at most once a minute per id. A charger with a `passwordEnv` that sends no password or the wrong one is refused with HTTP 401, logged the same way.

### `bridge`: timings

| Option | Type | Default | Required | What it does |
|---|---|---|---|---|
| `pollMs` | integer ≥ 1000 | 1000 (`ode-mqtt`), 60000 (`csip`) | no | `csip`: how often to poll the server. `ode-mqtt`: how often to check that messages are still arriving (they're pushed, not polled). |
| `tickMs` | integer, 100–60000 | 1000 | no | How often to recompute each charger's share and send any change. |
| `commsLostAfterMs` | integer ≥ 2000 | 3 × `pollMs` | no | `csip` only: no good poll for this long = comms lost, the default control applies. Must be longer than `pollMs`. For `ode-mqtt`, use `limitSource.commsLostAfterMs` (setting this one is an error). |

### `log`

| Option | Type | Default | What it does |
|---|---|---|---|
| `level` | `"debug"`, `"info"`, `"warn"`, `"error"` | `"info"` | Lowest level printed. Warnings and errors go to stderr. |
| `format` | `"text"` or `"json"` | `"text"` | `text`: `2026-10-23T05:12:00.123Z INFO  [bridge] message`. `json`: `{"time":…,"level":…,"component":…,"msg":…}` per line. |

Timestamps are UTC. The same warning repeated within a minute is printed once, then once a minute with a count.

### Not configurable yet

- A site meter (the code supports one, but only the simulated meter exists).
- OCPP Security Profiles 2 and 3 (TLS, `wss://`, client certificates). Profile 1 (passwords, `passwordEnv`) is supported, but without TLS the password crosses the network in plain text.
- Setting a charger's password from the bridge (2.0.1 `SetVariables` / 1.6 `ChangeConfiguration`); set it in the charger's own settings.
- Reading a charger's W/A and phase capabilities from the charger instead of from this file.

## Validation errors

The bridge checks the whole file before starting anything. If anything is wrong it lists **every** problem, with its path, and exits with code 2 instead of guessing:

```
2026-10-23T04:48:34.980Z ERROR [main] config.json is not valid, not starting:
2026-10-23T04:48:34.981Z ERROR [main]   - limitSource.password must not be in the config file: set the BRIDGE_MQTT_PASSWORD environment variable instead
2026-10-23T04:48:34.981Z ERROR [main]   - chargers[0].phase is not a known option (expected one of: id, rateUnit, phases, voltage, maxVoltage, ampStep, minAmpsPerPhase)
2026-10-23T04:48:34.981Z ERROR [main]   - chargers[1].id "CP1" is used twice
```

Unknown options are errors on purpose: a typo like `phase` for `phases` would otherwise silently fall back to the default. JSON syntax errors give the position (`not valid JSON: Expected ',' or '}' after property value in JSON at position 13 (line 3 column 3)`); line numbers count comments, since they're blanked out, not removed.

Warnings (the bridge still starts) are logged at `WARN` after the config loads: no `fallbackImportLimitW`, an amps charger with `maxVoltage` below 253 V, a username without a password, plain-http `csip` to a remote host, some chargers with a `passwordEnv` and some without, two chargers sharing one password variable, or a charger password that is exactly 40 hex digits (some OCPP 1.6 chargers treat that as a hex-encoded binary key and send different bytes).
