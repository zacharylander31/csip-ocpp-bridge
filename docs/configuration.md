# Configuration reference

> **Status: placeholder.** The config file and its validation are being built for v0.1 (`src/config.ts`, `config.example.*`). This page will list every option once they land.

## File location and format

*TODO (Tab C):* file name, format, where the bridge looks for it, and how to override the path.

## Options

*TODO (Tab C):* one row per option. Suggested layout:

| Option | Type | Default | Required | What it does |
|---|---|---|---|---|
| *e.g.* `mqtt.url` | string | — | yes | ODE's MQTT broker |

Options we expect to need, from the v0.1 plan (names to be confirmed by Tab C):

- **Limit source:** ODE's MQTT broker and topic (Tab A), or the built-in CSIP-AUS client for demos.
- **Fail-safe:** how long the limit source may be silent before the bridge applies a safe limit, and what that limit is (Tab A).
- **OCPP:** listen port, accepted protocol versions (1.6J, 2.0.1), and per-charger settings such as phases, voltage, and minimum current (Tab B).
- **Logging:** level and format (Tab C).

## Validation errors

*TODO (Tab C):* what an invalid config looks like on start-up, and that the bridge refuses to start rather than guess.
