# Tab D notes: repo, docs, CI

## What I built

| File | What it is |
|---|---|
| `README.md` | Pitch, the VGN gap, mermaid diagram, quick start (`npm ci` + `npm run bridge-demo`), what works / doesn't, v0.1 goal, relationship to ODE, licence. GIF placeholder at the top. |
| `docs/architecture.md` | CLAUDE.md sections 4, 5 and 7 rewritten for outsiders: sequence diagram, CSIP-AUS, OCPP, the bridge's three loops, splitting, fail-safe, telemetry, gotchas, file table. |
| `docs/testing.md` | Table of every demo: ports, run time, what it proves. "Adding a demo" checklist. |
| `docs/install.md` | Demo install (works today) + v0.1 sections as TODO placeholders. |
| `docs/configuration.md` | Placeholder for Tab C's config reference, with a suggested table layout. |
| `docs/recording-script.md` | Version A (one terminal, `bridge-demo`, works today) and Version B (three windows: Network / Bridge / Charger, needs Tab B + C). Timed shot list with captions. |
| `.github/workflows/ci.yml` | Push + PR, ubuntu-latest, Node 24, `npm ci`, typecheck, then each demo as its own step (sequential, 3 min timeout each, 20 min job). `mock-csip` excluded (runs forever). |
| `.github/ISSUE_TEMPLATE/charger-or-network-problem.md` | Charger make/firmware/OCPP version, network, ODE, config, logs; reminder to strip certs/LFDIs/NMIs. |
| `CONTRIBUTING.md` | Short: what helps most, checks before a PR, no secrets, Apache-2.0 inbound. |

## Decisions

- **Quick start uses `bridge-demo`, not `demo`:** it is the only one-command run that shows the full network → bridge → charger path.
- **CI: one step per demo** rather than a loop, so the GitHub UI shows which demo failed. Later steps are skipped after the first failure (fine: any failure fails the job).
- **Diagrams are mermaid** (GitHub renders them). No images to maintain.
- Every claim about networks, certification and ODE comes from CLAUDE.md or links its source (ODE repo/site, VGN summary, BSGIP explainer). The README says ODE is "certified with SA Power Networks", per CLAUDE.md section 3.

## Placeholders other tabs must fill

**Tab A (ODE input)**
- `docs/install.md` → "What happens when things fail": what the bridge does when ODE's MQTT goes silent.
- `docs/configuration.md` → MQTT broker/topic and fail-safe options.
- README "How it works" step 2 says the limit arrives "over MQTT from ODE"; check the wording matches what you built.
- New demos: add a row to `docs/testing.md` and a step to `.github/workflows/ci.yml`.

**Tab B (real-charger OCPP)**
- `docs/install.md` → "Point your chargers at the bridge": URL format, port, subprotocols, minimum current / pause behaviour.
- `docs/configuration.md` → per-charger options (phases, voltage, min current).
- `docs/recording-script.md` Version B → a **standalone simulated charger runner** (e.g. `npm run charger-sim -- --url ws://localhost:<port>/CP1`). There isn't one today; the sim only runs inside demos.
- README "What doesn't work yet" says 1.6J / amps / three-phase are in progress; update when done.
- New demos: row in `docs/testing.md`, step in `ci.yml`.

**Tab C (runtime & packaging)**
- `docs/install.md` → Docker Compose install, check it works, uninstall.
- `docs/configuration.md` → the whole options table, file location, validation errors.
- `docs/recording-script.md` Version B → a way to run the bridge standalone against `npm run mock-csip` (`http://localhost:8080/dcap`) with one charger.
- README quick start: add `docker compose up` once it works.
- Consider a `docker build` step in CI.

**Zach / main tab**
- Repo URL (`<repo-url>` in `docs/install.md`; end card in the recording).
- Security contact in `CONTRIBUTING.md` before going public.
- Demo GIF in the README once recorded.
- The `compatibility` label used by the issue template must exist on GitHub (create it, or GitHub just omits it).

## TODO / not verified

- CI has not run on GitHub yet (not pushed). Verified locally by running the same commands one after another on Windows / Node 24.19.0; ubuntu-latest may differ on timing.
- If demos get slower or more numerous, the 20-minute job timeout may need raising.
