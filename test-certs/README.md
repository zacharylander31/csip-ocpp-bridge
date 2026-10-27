# Test certificates (public, TEST ONLY)

Self-signed certificates and keys for `npm run ode-live` and the CI job that
runs the Docker stack. **They are public on purpose. Never use them for a real
site or network.** A real ODE uses the device certificate your network signs.

- `ode-device.*` — Open Dynamic Export's device certificate (its LFDI is
  pre-registered in the mock server).
- `mock-server.*` — the mock CSIP-AUS server's HTTPS certificate. ODE doesn't
  check the server certificate, so self-signed is enough.

Made with:

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 -subj "/CN=csip-ocpp-bridge TEST ONLY <name>" -keyout <name>.key.pem -out <name>.cert.pem
```
