# OCPP Security Profile 1 (charger passwords)

Branch `claude/ocpp-sp1-passwords-e030b9`, on top of `58ac9c3` (unknown ids refused with 404). 26 Oct 2026, Claude.

## What it does now

A charger in `config.json` can have `"passwordEnv": "BRIDGE_CP1_PASSWORD"`. The bridge reads the password from that environment variable at start-up. When the charger connects, it must send the password with HTTP Basic auth (username = its id), or the bridge refuses the connection with **HTTP 401** before the WebSocket opens. Chargers without `passwordEnv` connect as before.

Order of checks in `Manager`'s `auth` callback (`src/csms.ts`):
1. Id not configured → 404 (unchanged).
2. Id has a password and the charger sent none or a wrong one → 401, logged `REJECTED charger "CP1" from <ip>: no password|wrong password (HTTP 401) ...`.
3. Id has no password but the charger sent one, while other chargers do have one → info line "sent a password, but none is configured for it" (probably someone forgot `passwordEnv`). Accepted.
4. Otherwise accept.

Each (charger, reason) is logged at most once a minute, like the existing 404 log. The two reasons are logged separately, so "no password" doesn't hide a later "wrong password".

## Files

| File | Change |
|---|---|
| `src/csms.ts` | `ManagerOptions.passwords` (id → password); `passwordMatches()` (constant time); 401 path in `auth`; `logRefusal()` replaces the inline rate limiter. |
| `src/config.ts` | Per-charger `passwordEnv`; `passwordProblem()`; `chargerPassword()`; `ChargerEntry.password` / `.passwordEnv`; warnings. |
| `src/main.ts` | Passes `passwords` to `Manager`; start-up line says `password from <VAR>` or `no password` (never the value). |
| `src/chargerSim.ts` | `password` option, passed to ocpp-rpc's `RPCClient`. |
| `src/runChargerSim.ts` | `--password`; a 401 or 404 now exits with a clear reason instead of retrying forever. |
| `src/runSp1.ts` | New `npm run sp1-demo` (ports 8120 / 9040). |
| `src/checkConfig.ts` | 13 new password checks. |
| `config.example.json`, `docker-compose.yml`, `docs/*`, `.github/workflows/ci.yml` | Docs, `env_file: .env` for the bridge, CI step. |

`package.json`: new script `sp1-demo`. No new dependencies.

## Spec references (and how sure I am)

I couldn't download the OCA PDFs (they're behind a form), so some of this is from memory of the specs, checked against open-source implementations. **Zach: please check the starred items against the real PDFs before we quote them publicly.**

- **OCPP 2.0.1 Part 2, Security (section A, "Security Profile 1: Unsecured Transport with Basic Authentication")**: the charger authenticates with HTTP Basic auth (RFC 7617) on every connect; username = charging station identity; password = the `SecurityCtrlr.BasicAuthPassword` variable. Use case **A01** "Update Charging Station Password for HTTP Basic Authentication" sets it with `SetVariables`.
- **`BasicAuthPassword`**: `passwordString`, **min 16, max 40 characters, WriteOnly**. Confirmed in EVerest libocpp's standardised component config (`config/v2/component_config/standardized/SecurityCtrlr.json`: `minLimit 16`, `maxLimit 40`, `WriteOnly`). ★ Exactly which characters `passwordString` allows: I believe Part 2's primitive datatypes restrict it to a printable set; our check (printable ASCII, no spaces) may be looser than that, so the docs tell people to use letters, digits, `-` and `_`, which every reading allows.
- **OCPP 1.6 Security Whitepaper (Edition 3, "Improved security for OCPP 1.6-J")**: same SP1 scheme; the password is the `AuthorizationKey` configuration key (write-only), set with `ChangeConfiguration`. ★ From memory: at least 16 bytes, at most 20, and in `ChangeConfiguration` the value is **hex-encoded** (so up to 40 hex characters); the charger then sends the raw bytes in Basic auth. Supporting evidence: a charge-point operator's guide says hex keys are 32–40 characters (16–20 bytes); WARP chargers treat an exactly-40-hex-character password as a 20-byte key; EVerest's 1.6 code decodes a hex `AuthorizationKey` only if every byte is printable. Different chargers do different things here, which is why ocpp-rpc hands us the password as a `Buffer`, and why the config warns about 40-hex-digit passwords.
- **HTTP status codes**: unknown identity → 404 (OCPP-J, already done). Missing or wrong credentials → **401 Unauthorized** (RFC 7235 section 3.1; RFC 7617 is Basic auth). ★ I don't remember OCPP itself naming 401; it defers to HTTP. RFC 7235 says a 401 MUST carry a `WWW-Authenticate` header; **ocpp-rpc's `reject()` can't add headers**, so ours doesn't. Chargers send credentials up front (they don't wait for a challenge), so this shouldn't matter in practice, but it's a known deviation.

## Decisions, in plain words

- **Per charger, not all-or-nothing.** Many installed 1.6 chargers don't support the security whitepaper at all. If turning passwords on meant every charger needed one, a site with one old charger couldn't use passwords for any. So each charger opts in. The cost: a charger without a password can still be impersonated, so start-up warns, naming those chargers, whenever some have passwords and some don't. (No warning when none have passwords, so the examples and demos stay quiet; the docs recommend passwords.)
- **Passwords in environment variables, named per charger (`passwordEnv`).** Same rule as the MQTT password: config files get copied into bug reports and git; `.env` stays on the box (and is already in `.gitignore`). Why not a fixed name like `BRIDGE_PASSWORD_<id>`? Charger ids can contain `.`, `:`, `*` and so on, which aren't allowed in variable names. Why not a mounted secrets file? It's one more file and mount for installers; `.env` is already where the MQTT password goes. Docker: the bridge service now has `env_file: .env` (`required: false`), so any variable in `.env` reaches the bridge, and only the bridge. Needs Compose v2.24+ (noted in `docs/install.md`).
- **Fail at start-up, never half-work.** A `passwordEnv` whose variable is unset or empty is an error, not a warning: carrying on would lock the real charger out. Wrong length (outside 16–40), spaces, newlines (typical copy-paste trailing newline) or non-ASCII are errors too. The error says the length or the kind of problem, **never the password**.
- **`password` in the file is an error**, pointing to `passwordEnv`. `passwordEnv` in `chargerDefaults` is an error: one shared password lets any charger pose as any other. Two chargers naming the same variable is a warning.
- **Constant-time comparison.** `a === b` stops at the first different character, so in theory an attacker timing many attempts can learn the password one character at a time. `crypto.timingSafeEqual` always compares every byte but throws if the lengths differ. We SHA-256 both sides first: both are then 32 bytes, so lengths always match, and the real password's length doesn't leak either. (Over a LAN the timing leak is tiny, but it's two lines to do properly.)
- **Passwords compared as bytes.** The expected password is UTF-8 bytes; ocpp-rpc gives the sent one as a `Buffer`. ocpp-rpc only fills in `handshake.password` if the Basic auth username equals the id in the URL, so a mismatched username counts as "no password".
- **Never logged.** No log line contains a password. The demo checks every output line for each password and for the base64 of `id:password` (what's actually on the wire).
- **Not done: setting the password from the bridge** (2.0.1 `SetVariables` on `SecurityCtrlr.BasicAuthPassword`, 1.6 `ChangeConfiguration` on `AuthorizationKey`). It's not small: the charger reconnects with the new password, so the bridge must accept both old and new during the switch, and must store the new one somewhere other than `.env` (which it can't write). Set it on the charger by hand for now.

## What SP1 does and doesn't protect against

Without TLS, the password crosses the LAN in plain text on every connect (Basic auth is base64, not encryption), and so does every OCPP message. It stops a misconfigured or casual device from connecting as a charger. It doesn't stop someone who can watch the network traffic. Next step: **Security Profile 2** (TLS, `wss://`, server certificate; ocpp-rpc supports it by passing an `https` server). Said in `docs/install.md` and `docs/configuration.md`.

## Tests

- `npm run config-test`: 13 new checks (password read from env; in-file password, unset variable, bad variable name and `chargerDefaults.passwordEnv` rejected; too short, too long, trailing newline rejected and the error doesn't repeat the password; 40 characters accepted; warnings for mixed, shared and 40-hex passwords).
- `npm run sp1-demo` (~3 s, ports 8120 / 9040): runs `src/main.ts` as a process with the password in its environment. Too-short password → exit 2. CP1 with no password → 401; wrong short and wrong same-length passwords → 401, with exactly one wrong-password warning for two tries; unconfigured CPX → 404; CP1 with the right password connects, and CP1 and CP2 (no password) each get 2500 W; start-up warns about CP2; no password or its base64 in the output; clean shutdown. **PASS 3/3.** Added to CI.
- Tried by hand: `charger-sim` with no password → "it needs a password (--password)", with a wrong one → "wrong password", with the right one → connects.
- All existing demos, `typecheck`, `build`, `config-test` pass. `docker compose config` with the new `env_file` was **not** run locally (no Docker here); the CI docker job checks it.

## TODOs

- Check the ★ spec items against the real OCA PDFs.
- Set the password from the bridge (A01 / `ChangeConfiguration`), with an old+new overlap.
- Optional hex/binary password support for 1.6 chargers that send `AuthorizationKey` as raw bytes (e.g. a `passwordEncoding: "hex"` option).
- `WWW-Authenticate` header on 401 (needs an ocpp-rpc change or our own upgrade handler).
- Slow down repeated wrong-password attempts per IP (today they're only logged less often). With 16+ random characters, guessing isn't realistic, so low priority.
- Security Profile 2 (TLS).
