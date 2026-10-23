---
name: My charger or network doesn't work
about: The bridge doesn't work with a specific charger, network or Open Dynamic Export setup
title: "[compat] <charger or network>: <what goes wrong>"
labels: compatibility
---

<!--
Please remove anything private before posting: certificates, keys, LFDIs/SFDIs,
NMIs, addresses, IP addresses and passwords. Logs are fine once those are removed.
-->

## What happened

<!-- What did you expect, and what happened instead? -->

## Charger

- Make and model:
- Firmware version:
- OCPP version (1.6J / 2.0.1 / other):
- Phases (single / three):
- Number of chargers at the site:

## Network side

- Network (e.g. SA Power Networks, Energex, Ergon, Jemena):
- Connected through Open Dynamic Export? (yes / no, and ODE version):
- Is the site registered with the network for CSIP-AUS? (yes / no / don't know):

## Bridge

- Bridge version or commit:
- How it's running (Docker / `npm`, and on what hardware):
- Config file (with private values removed):

```
paste here
```

## Logs

<!-- The bridge's log around the problem. If you can, include the OCPP messages
(SetChargingProfile and the charger's reply). -->

```
paste here
```

## Anything else

<!-- Charger settings you changed, whether it worked before, workarounds you found. -->
