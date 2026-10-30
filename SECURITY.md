# Security policy

This bridge decides how much power EV chargers may draw on a site that a network has limited. A security bug here could let someone lift those limits, control chargers without permission, or read charger passwords. Please report it privately first.

## How to report

Use GitHub's private vulnerability reporting: on this repository, open the **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/zacharylander31/csip-ocpp-bridge/security/advisories/new)). Only the maintainers see the report, and we can discuss and fix it there before anything is public.

Please don't open a public issue, pull request or discussion for a security problem.

Useful things to include: what an attacker can do, what they need first (on the site's network? knows a charger id?), steps to reproduce, and the commit or version you tested.

## What to expect

This is a small project run in spare time, so please allow a few days for a first reply. We'll tell you what we plan to do, credit you in the fix if you'd like, and agree a date with you before anything is published.

## Known limitations (not vulnerabilities)

These are documented and already on the list; reports adding detail are still welcome:

- No TLS between charger and bridge (OCPP Security Profile 2 isn't implemented). Charger passwords (Security Profile 1) cross the local network in plain text.
- Charger passwords are optional per charger. A charger without one can be impersonated by any device on the network that knows its id.
- The bridge's own CSIP-AUS client (`limitSource.type: "csip"`) has no TLS or certificates and is meant for the mock server only. Real sites get their limits from Open Dynamic Export, which handles CSIP-AUS security.
- The MQTT broker in `docker-compose.yml` allows anonymous connections but isn't published outside the Docker network.

## Supported versions

Only the latest commit on `main` until the first tagged release.
