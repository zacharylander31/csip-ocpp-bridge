# Install guide

> **Status: placeholder.** The production setup (Docker, config file, running next to Open Dynamic Export) is being built for v0.1. Sections marked *TODO (Tab C)* will be filled in when it lands. Until then, only the demos below work.

## Run the demos (works today)

Needs Node 24 and npm.

```bash
git clone <repo-url>
cd csip-ocpp-bridge
npm ci
npm run bridge-demo
```

Everything runs on your machine: a mock CSIP-AUS server, the bridge and simulated chargers. No hardware, network account or certificates needed. See [testing.md](testing.md) for the other demos.

## Run on a site box with Open Dynamic Export (v0.1)

### What you need

- A Raspberry Pi-class Linux box (or any machine with Docker) on the same network as the chargers.
- An [Open Dynamic Export](https://github.com/longzheng/open-dynamic-export) install that is already registered with your network. ODE handles the CSIP-AUS connection, TLS and certificates; this bridge does not.
- One or more OCPP chargers (1.6J or 2.0.1) that you can point at a custom central system (CSMS) URL.

### Install with Docker Compose

*TODO (Tab C):* `docker compose up` steps, which services start (bridge, ODE, MQTT broker), where the config file goes, how to check it's running.

### Point your chargers at the bridge

*TODO (Tab B / Tab C):* the OCPP URL format (`ws://<box>:<port>/<chargerId>`), the port, which subprotocols are accepted, and per-charger settings that matter (for example the minimum current before pausing).

### Check it works

*TODO (Tab C):* log lines to look for when ODE's limit arrives and when a charger accepts a cap.

### What happens when things fail

*TODO (Tab A / Tab C):* what the bridge does when ODE's MQTT feed goes silent, when a charger disconnects, and on clean shutdown.

## Uninstall

*TODO (Tab C).*
