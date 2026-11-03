# Install guide

> **Status: v0.1, not tagged yet.** The full Docker Compose stack (bridge + mosquitto + the real ODE `v0.20.0` image) passes in CI against a mock CSIP-AUS server and a simulated charger. It has **not** run against a real network's server or a real charger, and the arm64 (Raspberry Pi) image hasn't been built or tested. Treat a real install as a trial and watch it.

## Run the demos (no hardware)

Needs Node 24 and npm.

```bash
git clone https://github.com/zacharylander31/csip-ocpp-bridge.git
cd csip-ocpp-bridge
npm ci
npm run showcase
```

Everything runs on your machine in about a minute: a mock CSIP-AUS server, the bridge and a simulated charger. No hardware, network account or certificates needed. See [testing.md](testing.md) for the other demos.

### Run the real program against the mock server

The same program a site runs (`npm start`), in three terminals:

```bash
npm run mock-csip
```

```bash
npm start -- --config config.example.mock-csip.json
```

```bash
npm run charger-sim -- --url ws://localhost:9030/CP1
```

The mock serves a 5 kW default, then a 3 kW control from 10 s to 40 s after it starts. The charger terminal shows `drawing 5000 W` → `drawing 3000 W` → `drawing 5000 W`. You can stop and restart the bridge: the simulated charger keeps its cap and reconnects by itself. `charger-sim` options (OCPP 1.6, three-phase, amps-only) are listed at the top of [`src/runChargerSim.ts`](../src/runChargerSim.ts).

## Run on a site box with Open Dynamic Export (v0.1)

### What you need

- A Raspberry Pi-class Linux box (or any machine with Docker and Docker Compose v2.24 or later: `docker compose version`) on the same network as the chargers.
- An [Open Dynamic Export](https://github.com/longzheng/open-dynamic-export) (ODE) setup for your network: its CSIP-AUS server address, and the device certificate and key your network issued. ODE handles the CSIP-AUS connection, TLS and certificates; this bridge does not. ODE also needs a site meter configured ([ODE meter docs](https://github.com/longzheng/open-dynamic-export/blob/main/docs/configuration/meter.md)).
- One or more OCPP chargers (1.6J or 2.0.1) that you can point at a custom central system (CSMS) URL.

### Install with Docker Compose

[`docker-compose.yml`](../docker-compose.yml) runs three containers:

| Service | What it is | Port on the box |
|---|---|---|
| `open-dynamic-export` | ODE `v0.20.0` (`longzhengau/open-dynamic-export`): talks CSIP-AUS to the network, publishes the limit over MQTT | 3000 (ODE dashboard) |
| `mosquitto` | MQTT broker between ODE and the bridge (`eclipse-mosquitto:2.0.22`) | none: only reachable by the other two containers |
| `bridge` | This project, built from the [`Dockerfile`](../Dockerfile) | 9000 (OCPP, for the chargers) |

1. Get the code:
   ```bash
   git clone https://github.com/zacharylander31/csip-ocpp-bridge.git
   cd csip-ocpp-bridge
   ```
2. Configure the bridge: copy the example and edit it (at least `chargers`, and `fallbackImportLimitW`). Every option is in [configuration.md](configuration.md).
   ```bash
   cp config.example.json config.json
   ```
3. Configure ODE: copy its example and edit it. Set `setpoints.csipAus` (your network's `host` and `dcapUri`, and `fixedDefault` from your connection agreement), your `inverters` and `meter`. Leave `publish.mqtt` as it is: that's how ODE reaches the bridge. See [ODE's configuration docs](https://github.com/longzheng/open-dynamic-export/tree/main/docs/configuration).
   ```bash
   mkdir -p ode/config
   cp ode/config.example.json ode/config/config.json
   ```
4. Put ODE's CSIP-AUS certificate and key in `ode/config/` as `cert.pem` and `key.pem`. (`ode/config/` is in `.gitignore`, so they can't be committed by accident.)
5. Passwords go in a `.env` file next to `docker-compose.yml`, never in `config.json` (see [Charger passwords](#charger-passwords-ocpp-security-profile-1) below):
   - `BRIDGE_MQTT_PASSWORD=...`, only if your broker needs a password;
   - one line per charger password, e.g. `BRIDGE_CP1_PASSWORD=...`, named by that charger's `passwordEnv` in `config.json`.

   Make it readable only by you: `chmod 600 .env`. It's in `.gitignore`.
6. Check the bridge config, then start everything:
   ```bash
   docker compose run --rm bridge node dist/main.js --check
   ```
   ```bash
   docker compose up -d
   ```

`docker compose up -d` builds the bridge image the first time (a minute or two on a Pi). All three containers restart by themselves after a crash or reboot (`restart: unless-stopped`).

### Point your chargers at the bridge

In each charger's settings (installer app or web page), set the OCPP central system / CSMS URL to:

```
ws://<the box's IP address>:9000/<charger id>
```

- `<charger id>` must match an `id` in `config.json`'s `chargers` list. Many chargers add their own id to the end of the URL; then enter only `ws://<box>:9000/`.
- Protocol: OCPP **1.6J** or **2.0.1** (subprotocols `ocpp1.6` and `ocpp2.0.1`; 2.0.1 is chosen if a charger offers both). Optional charger passwords (Security Profile 1, below); no TLS yet, so keep the chargers and the box on a private network.
- Port 9000 is `ocpp.port`. If you change it, change the `ports:` line in `docker-compose.yml` to match.
- Settings that matter per charger (see [configuration.md](configuration.md#chargerdefaults-and-chargers)): `rateUnit` (does it take W or A), `phases`, `minAmpsPerPhase`, and for amps chargers `maxVoltage` (leave it at 253 V). A car stops charging below about 6 A per phase, so when a charger's share is below that, the bridge pauses it (0 W) instead of sending a limit the car can't use. On three-phase that's 4140 W.
- Only chargers listed in the config can connect. Any other id is **refused** (HTTP 404) and the bridge logs `REJECTED charger "<id>"` with the ids it expected. Ids are case-sensitive: copy the id exactly as the charger's OCPP settings show it.

### Charger passwords (OCPP Security Profile 1)

Without a password, any device on your network that knows a charger's id can connect as that charger, and the real charger is then never capped. OCPP Security Profile 1 fixes that: the charger sends a password with HTTP Basic auth every time it connects, and the bridge refuses it (HTTP 401) if the password is missing or wrong.

1. Make a random password for each charger (16 to 40 characters; this gives 24 letters, digits, `-` and `_`):
   ```bash
   node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
   ```
2. Enter it in the charger's OCPP settings. It's usually called *password*, *basic auth password* or *authorization key* (OCPP 2.0.1: `BasicAuthPassword`; 1.6: `AuthorizationKey`). Set the security profile to 1 if the charger asks. Use a different password for each charger.
3. Put it in `.env` and tell the bridge its name, per charger:
   ```
   BRIDGE_CP1_PASSWORD=<the password>
   ```
   ```jsonc
   "chargers": [{ "id": "CP1", "passwordEnv": "BRIDGE_CP1_PASSWORD" }]
   ```
4. `docker compose up -d` (not `restart`: that keeps the old environment and misses changes to `.env`). A wrong password shows as `REJECTED charger "CP1" ...: wrong password (HTTP 401)` in `docker compose logs bridge`. The bridge never logs a password.

A charger without `passwordEnv` still connects without one, so a charger that doesn't support passwords can share a site with ones that do; the bridge warns about it at start-up.

**Security Profile 1 is not encryption.** Without TLS, the password crosses your network in plain text on every connect (Basic auth is only base64, which anyone can decode), and so does every OCPP message. Anyone who can watch that traffic (a compromised device on the same network or Wi-Fi) can copy the password. It stops a misconfigured or casual device from posing as a charger; it does not stop a determined attacker on your LAN. Keep the chargers and the box on a private network or VLAN. The next step is Security Profile 2 (TLS, `wss://`), which the bridge doesn't support yet.

### Site meter

The network's limit is for the whole site, so the bridge needs to know what the house uses. It reads the meter you set up in ODE: nothing to wire up, just keep `siteMeter` in `config.json` ([options](configuration.md#sitemeter-so-chargers-only-get-what-the-house-isnt-using)).

Check these on a new site:

1. **The meter's sign.** ODE's dashboard should show the site's power as positive when importing and negative when exporting. A CT clamp on backwards breaks ODE's solar control too, and would hand the chargers power that isn't there.
2. **Each charger's power reports.** House load is the site meter minus what the chargers report, so a charger's draw that the bridge doesn't know about looks like house load. The bridge asks every charger to report `Power.Active.Import` every 5 s when it connects. Look for `CP1 reports power every 5 s` in the log. If you see `Rejected the power report settings` or `couldn't set power reports` instead, set it in the charger's own settings if you can. If the charger reports more slowly, raise `siteMeter.chargerIdleAfterMs` to more than the time between its reports. **A charger that never reports power will be cut and raised over and over:** safe for the limit, but no good for charging. This hasn't been tried on real chargers yet, so please [report what you find](../CONTRIBUTING.md).

### Check it works

```bash
docker compose ps
```

```bash
docker compose logs -f bridge
```

Log lines to look for, in order:

```
INFO  [main] starting: limits from ode-mqtt (mqtt://mosquitto:1883), site meter from ode-rest (http://open-dynamic-export:3000), 1 charger(s): CP1 (W, 1-phase, 230 V nominal / 253 V max, min 6 A, password from BRIDGE_CP1_PASSWORD)
INFO  [ocpp] listening on ws://localhost:9000
INFO  [ode-mqtt] connected to mqtt://mosquitto:1883, subscribing to limits/csipAus
INFO  [main] running
INFO  [ocpp] CP1 connected (OCPP 2.0.1)
INFO  [ocpp] CP1 reports power every 5 s
INFO  [bridge] site limit 5000 W (default), house 1000 W -> 4000 W each for CP1
INFO  [ocpp] CP1 SetChargingProfile 4000 W -> Accepted
```

- `site limit ... (default)` or `(control <mRID>)`: the limit arrived from ODE.
- `house 1000 W`: the site meter is being read. `house load unknown` with `0 W each` means it isn't yet: normal for the first few seconds, while ODE starts.
- `SetChargingProfile ... -> Accepted`: the charger took the cap.
- ODE's dashboard (`http://<box>:3000`) shows what ODE itself received from the network.

Each line has a UTC timestamp, a level and a component (`main`, `bridge`, `ocpp`, `ode-mqtt`, `site-meter`). Set `"log": { "format": "json" }` for one JSON object per line.

### What happens when things fail

| What fails | What the bridge does |
|---|---|
| **ODE or the broker goes silent** (no valid message for `limitSource.commsLostAfterMs`, default 10 s) | Logs `COMMS LOST` and applies the **default** limit: the network's default control as last seen from ODE, else `fallbackImportLimitW`. If neither is known, caps are removed, which is why setting `fallbackImportLimitW` matters. When messages come back, it follows ODE again. Note: ODE keeps following its cached schedule when *it* loses the network, so "silent" means ODE or the broker is down, not the network. |
| **The site meter goes silent** (no new sample from ODE for `siteMeter.silentAfterMs`, default 15 s: ODE down, or its meter dead) | Logs `SITE METER SILENT` and gives the chargers **0 W**: the house could be using anything, and 0 W is the only share that can't break the limit. Charging resumes by itself when readings come back. So restarting ODE pauses charging if it takes longer than that. |
| **A bad MQTT message** | Ignored; it never changes the limit, and doesn't count as "still alive". Logged at most once per 30 s. |
| **A charger disconnects** | Its share is still reserved (the site limit is split over every configured charger). When it reconnects, the bridge re-sends its cap before counting it as compliant. Logs `couldn't update CP1 ... offline` (folded to once a minute) meanwhile. If it's still drawing, that draw counts as house load, so the other chargers get less: the safe side. |
| **A charger rejects a cap** | Logged and retried every tick. Usually means `rateUnit` is wrong for that charger. |
| **The bridge stops** (`docker compose stop`, SIGTERM, Ctrl+C) | Stops cleanly within a few seconds and **leaves each charger's last cap in place**. Removing caps on the way out would let every charger draw full power while nothing enforces the network's limit. On restart it sends every charger its current share straight away. |
| **The bridge crashes** | Exits; Docker restarts it. Caps stay on the chargers in the meantime. |
| **Bad config** | Refuses to start, lists every problem, exits with code 2. Docker will keep restarting it until the config is fixed: check `docker compose logs bridge`. |

Not handled yet: caps don't expire by themselves, so if the bridge is gone for good, a charger keeps its last cap until it reboots (many chargers forget profiles on reboot) or is pointed at another CSMS.

## Uninstall

1. Point each charger back at its previous CSMS (or none). Do this **first**: the bridge leaves its last cap on each charger, and that cap stays until another CSMS clears it or the charger reboots.
2. Stop and remove the containers and the bridge image:
   ```bash
   docker compose down --rmi local
   ```
3. Delete the folder. `config.json` and `ode/config/` hold your site's settings, certificate and key: keep a copy if you need them, otherwise delete them securely.
