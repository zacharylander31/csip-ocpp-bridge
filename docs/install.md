# Install guide

> **Status: v0.1 in progress.** Docker Compose install and `npm start` work, but the bridge has only been run against simulated chargers and a fake ODE, not real hardware. Treat a real install as a trial.

## Run the demos (no hardware)

Needs Node 24 and npm.

```bash
git clone <repo-url>
cd csip-ocpp-bridge
npm ci
npm run bridge-demo
```

Everything runs on your machine: a mock CSIP-AUS server, the bridge and simulated chargers. No hardware, network account or certificates needed. See [testing.md](testing.md) for the other demos.

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

The mock serves a 5 kW default, then a 3 kW control from 10 s to 40 s after it starts. The charger terminal shows `drawing 5000 W` → `drawing 3000 W` → `drawing 5000 W`. `charger-sim` options (OCPP 1.6, three-phase, amps-only) are listed at the top of [`src/runChargerSim.ts`](../src/runChargerSim.ts).

## Run on a site box with Open Dynamic Export (v0.1)

### What you need

- A Raspberry Pi-class Linux box (or any machine with Docker and Docker Compose v2) on the same network as the chargers.
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
   git clone <repo-url>
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
5. Only if your broker needs a password: create a `.env` file next to `docker-compose.yml` with `BRIDGE_MQTT_PASSWORD=...`. The password never goes in `config.json`.
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
- Protocol: OCPP **1.6J** or **2.0.1** (subprotocols `ocpp1.6` and `ocpp2.0.1`; 2.0.1 is chosen if a charger offers both). No TLS or OCPP security profiles yet, so keep the chargers and the box on a private network.
- Port 9000 is `ocpp.port`. If you change it, change the `ports:` line in `docker-compose.yml` to match.
- Settings that matter per charger (see [configuration.md](configuration.md#chargerdefaults-and-chargers)): `rateUnit` (does it take W or A), `phases`, `minAmpsPerPhase`, and for amps chargers `maxVoltage` (leave it at 253 V). A car stops charging below about 6 A per phase, so when a charger's share is below that, the bridge pauses it (0 W) instead of sending a limit the car can't use. On three-phase that's 4140 W.
- A charger that connects with an id that isn't in the config is **not capped**, and the bridge logs a warning.

### Check it works

```bash
docker compose ps
```

```bash
docker compose logs -f bridge
```

Log lines to look for, in order:

```
INFO  [main] starting: limits from ode-mqtt (mqtt://mosquitto:1883), 1 charger(s): CP1 (W, 1-phase, 230 V nominal / 253 V max, min 6 A)
INFO  [ocpp] listening on ws://localhost:9000
INFO  [ode-mqtt] connected to mqtt://mosquitto:1883, subscribing to limits/csipAus
INFO  [main] running
INFO  [ocpp] CP1 connected (OCPP 2.0.1), reconnect
INFO  [bridge] site limit 5000 W (default) -> 5000 W each for CP1
INFO  [ocpp] CP1 SetChargingProfile 5000 W -> Accepted
```

- `site limit ... (default)` or `(control <mRID>)`: the limit arrived from ODE.
- `SetChargingProfile ... -> Accepted`: the charger took the cap.
- ODE's dashboard (`http://<box>:3000`) shows what ODE itself received from the network.

Each line has a UTC timestamp, a level and a component (`main`, `bridge`, `ocpp`, `ode-mqtt`). Set `"log": { "format": "json" }` for one JSON object per line.

### What happens when things fail

| What fails | What the bridge does |
|---|---|
| **ODE or the broker goes silent** (no valid message for `limitSource.commsLostAfterMs`, default 10 s) | Logs `COMMS LOST` and applies the **default** limit: the network's default control as last seen from ODE, else `fallbackImportLimitW`. If neither is known, caps are removed, which is why setting `fallbackImportLimitW` matters. When messages come back, it follows ODE again. Note: ODE keeps following its cached schedule when *it* loses the network, so "silent" means ODE or the broker is down, not the network. |
| **A bad MQTT message** | Ignored; it never changes the limit, and doesn't count as "still alive". Logged at most once per 30 s. |
| **A charger disconnects** | Its share is still reserved (the site limit is split over every configured charger). When it reconnects, the bridge re-sends its cap before counting it as compliant. Logs `couldn't update CP1 ... offline` (folded to once a minute) meanwhile. |
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
