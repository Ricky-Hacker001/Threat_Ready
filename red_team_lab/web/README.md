# ThreatReady — Web Pentest Lab (TR-RED-001: The Breach Files)

A standalone, **story-driven, server-authoritative** web-application penetration-testing simulation.
The learner joins a security consultancy as a junior pentester and runs an authorized engagement
against **NovaCart**, a fictional e-commerce app: recon → exploit → remediate → verify → report,
using an embedded browser, a Burp-style proxy/repeater, and a Kali-style terminal.

**SIMULATION ONLY.** No real company, customer, credential, system, or network is involved. Every
identity, order, address, secret, flag and "exploit" is synthetic and resolves against an in-memory
data model. Nothing is ever executed, fetched or read for real.

This is the first web vertical of the ThreatReady platform (Architecture Decision Document §7, V1.2:
"Network Security and Red Team web pentest labs"). It follows the platform's lab conventions but is a
standalone prototype (Express + atomic JSON file), mirroring the existing TR-CLOUD-001 lab's shape.

## Run it

Requires Node.js 20.11+ (22/24 recommended).

```bash
npm install
npm run build      # builds the React client into dist/
npm start          # http://localhost:4300/lab/   (API + client, standalone dev login)
```

Development with hot reload:

```bash
npm run dev        # client on http://localhost:5180/lab/ , API on :4300 (proxied)
```

### Guidance modes (pick your difficulty)

Chosen on the catalog card and switchable any time from the top-bar dropdown — all three run the
**same** lab engine; only how much the UI guides you changes:

- **Beginner** — a step-by-step walkthrough banner (Step X of N) telling you exactly what to do, in
  which tool, with the exact input, plus a "Go to <tool>" jump and an expandable checklist that
  auto-ticks as you progress. Hints too.
- **Intermediate** — a one-line goal for the current level, plus on-demand hints.
- **Advanced** — objective titles and on-demand hints only, like a real engagement.

The beginner walkthrough (which contains the exact payloads) is **server-only and sent to the browser
only for a beginner-mode session** — Intermediate/Advanced never receive it, so the answers can't be
read out of the page (asserted in tests).

An in-app **Guide** (top-bar button, auto-opens once for first-timers) explains the workflow, every
tool, a terminal cheat-sheet and good habits; its links jump straight to the relevant tool. Every
objective in the left sidebar also has **staged "Reveal hint" buttons** (progressive, −25% each).

In **Beginner** mode a **pointing guide** pulses a dot on the tab the current step wants you in, and
each step has a "why this step / why this level" explanation plus one-click actions ("Run" a command,
"Do it in the Browser", "Load into Repeater", or per-page buttons).

The workspace is fully responsive: on narrow screens the Mission and Activity sidebars become
slide-in drawers (toggles in the tab bar).

> Note: `npm start` runs the server without watch, so after pulling server-side changes, restart it.
> `npm run dev` hot-reloads both client and server.

On localhost a **cookie-based dev login** is offered (no external identity provider needed): enter a
display name and start. Set `APP_SECRET` to keep dev sessions across restarts. For platform parity,
set `DEV_LOGIN=false` and point `ONBOARD_URL`/`IDENTITY_URL`/`INTERNAL_API_TOKEN` at onboard (see
`.env.example` and `../../README.md`).

Progress is stored in `data/store.json` (set `DATA_FILE` to move it). Reset from the top bar → Reset.

## Tests

```bash
npm test                              # 16 unit + API-security tests (Vitest + Supertest)
npm run build && npm run test:e2e     # browser end-to-end (Playwright; needs Chromium:
                                      #   npx playwright install chromium)
npm run typecheck
```

`tests/helpers.ts` contains a full scripted solution (`solve.recon/exploit/document/remediate/report`)
used **only in tests** as an answer key — it proves every vulnerability is reachable and that
remediation + re-test marks each one verified. It is never shipped to the browser.

## The engagement

One deeply implemented target (**NovaCart**) with **nine vulnerability classes**, each intentional,
reproducible, server-detected and separately remediable:

| ID | Class | Where | Fix verified by |
|---|---|---|---|
| V-SQLI | SQL injection (auth bypass + UNION dump) | `POST /login`, `GET /product` | parameterised query → bypass now 401 |
| V-RXSS | Reflected XSS | `GET /search` | output-encode → tag rendered encoded |
| V-SXSS | Stored XSS | `/support/ticket`, `/admin/tickets` | encode on render → sink inert |
| V-IDOR | Broken object-level authz (+ data exposure) | `GET /api/order` | owner check → 403 cross-owner |
| V-JWT | Forgeable admin session (weak HS256 secret) | `GET /admin` | rotate + server-issued only → forged 403 |
| V-FILE | Sensitive file exposure (DB backup, `.env`) | `GET /download` | remove from web root → 404 |
| V-TRAVERSAL | Path traversal | `GET /download` | canonicalise + jail → 403 |
| V-CMD | OS command injection | `GET /admin/ping` | argv/validate → 400 |
| V-SSRF | SSRF to internal metadata | `GET /admin/fetch` | host allowlist → 400 |

**Progression.** Four levels gate on server-validated state: **1 Reconnaissance** (map routes, find the
API and admin console) → **2 Exploitation** (confirm each vuln with real traffic) → **3 Remediation**
(apply the correct fix, then re-test to **verify**) → **4 Reporting** (document severities, attach
evidence, deliver the report). The chain is realistic: the exposed backup/`.env` leaks the weak JWT
secret, which forges the admin token, which unlocks the admin-only command-injection and SSRF sinks.

**Finding lifecycle:** `Not found → Confirmed (demonstrated in traffic) → Documented → Remediated →
Verified`. A fix is never auto-verified: remediation flips target behaviour, and verification requires
a passing re-test of the original proof request. Re-introducing a weakness would fail the re-test.

## Tools (all share one target state)

- **Embedded browser** — address bar (GET/POST + body), sandboxed render of the server-produced HTML
  (scripts do **not** execute in-page; payloads render inert — detection is server-side), extracted
  link chips, cookie jar + set-cookie (e.g. paste a forged `nc_admin` token), proxy intercept toggle.
- **Proxy** — full HTTP history across every tool, raw request/response viewer, per-row detection
  flags, "send to Repeater", "save to evidence".
- **Repeater** — editable method/path/query/headers/cookies/body, send, response viewer.
- **Terminal (xterm.js)** — server-side interpreter; security tools are thin clients of the same target
  handler: `curl` `http` `whatweb` `nmap` `ffuf` `gobuster` `nikto` `sqlmap` `jwt` `base64` plus
  `ls cd pwd cat head tail grep find wc echo env history clear help`. Unsupported flags report
  "not supported"; pipes capped at 10; no loops, no shell-out, no real network.
- **Findings** — document (severity + note), choose a remediation (answer key server-side), re-test to
  verify; root cause + remediation text revealed once verified.
- **Report** — executive summary + per-finding severities + evidence → browsable HTML report with
  Print/PDF and JSON export, built entirely from stored server numbers.

## Architecture

```
server/http.ts      HTTP request/response model + parsing shared by every tool.
server/fixture.ts   Seeded initial NovaCart state (users, products, orders, tickets, files, weak secret, canary flags).
server/target.ts    The vulnerable app: a PURE handler(state, req) -> { response, detection events, Set-Cookie }.
server/terminal.ts  Kali-style command interpreter; security tools call the shared target handler.
server/scenario.ts  SERVER-ONLY: findings, detection→confirmation mapping, objectives, hints, remediation answer keys, report rubric.
server/engine.ts    LabEngine: dispatch (validate → run → confirm/verify → recompute levels), view()/status()/report() projections, scoring.
server/store.ts     Persistence boundary (atomic JSON file).
server/identity.ts  Dev-login (standalone) + onboard resolver (platform parity).
server/app.ts       REST API: auth, ownership, Origin check, idempotency, actions, reset, report, internal summary.
client/src/*        React + Vite + TypeScript workstation (presentation only: renders state, sends actions).
```

Rules the code enforces (asserted in tests):

- **Server-authoritative.** The client sends `{type, params, requestId}`. The engine validates, runs a
  pure handler on a clone, confirms findings only from real detection events, recomputes objectives,
  and commits state + idempotency record together. A failed action changes nothing but the failure log.
- **No answers in the browser.** `view()`/`status()`/`report()` are the only projections. Remediation
  answer keys (`correct`), hints not yet requested, detection predicates, the weak JWT secret and the
  canary flag values never leave the server. (A flag the learner *exfiltrates* is loot and appears in
  their own history — that is the point of the exploit.)
- **Confirm ≠ document ≠ verified.** A vuln is Confirmed only when the learner's traffic triggers its
  server-side detection; Documented only when filed with a severity; Verified only after a passing
  re-test while remediated.
- **Shared state.** Browser, proxy, repeater and terminal all funnel through one request processor, so a
  forged cookie set in the browser, a payload sent in Repeater, and a `sqlmap` run in the terminal all
  see and change the same target.

## Sandbox / security boundaries

- Synthetic domain (`shop.novacart.lab`) and in-memory routing; no outbound network from any tool.
- "SSRF" reaches only a synthetic canary metadata response; "command injection" and "path traversal"
  reach only synthetic canary flags / a virtual file map — never the real host.
- SQLi/XSS are resolved by deterministic detectors over the synthetic model; XSS uses inert proof
  markers (the embedded render has no `allow-scripts`).
- Per-session isolation: a session is reachable only by its owner (404, never 403, for others).
- State-changing requests require the app `Origin`; actions are idempotent by `requestId`.
- Input is bounded (body/line/payload sizes); the terminal rejects unknown flags and caps pipelines.

## Integration boundary (standalone prototype → platform)

| Platform (ADD) | This prototype | To integrate |
|---|---|---|
| NestJS modular monolith, `labs/core` + `labs/engines/web-pentest` | Express, one `LabEngine` | Wrap `engine.ts` as a Nest engine; map `app.ts` routes 1:1 |
| PostgreSQL (`lab_instances`/`lab_state`/`lab_events`) | Atomic JSON file behind `Store` | Implement `Store` on the schema; SQLite image as the one blob key |
| `@sqlite.org/sqlite-wasm` in a worker | Deterministic SQLi detectors | Swap the login/UNION detectors for a jailed SQLite image |
| Target in a sandboxed iframe on a separate registrable domain | Server-rendered HTML in an in-app sandboxed iframe (no scripts) | Serve the target on its own hostname; keep detection server-side |
| Declarative detection-rule JSON | TypeScript predicates in `scenario.ts` | Lift predicates to the rule DSL |
| Worker-built PDF report | Synchronous report + client Print/PDF | Move to the report worker |
| Platform auth (onboard) | Done: dev login + onboard resolver | Set `DEV_LOGIN=false` |

## Add a vulnerability

1. Add the vulnerable behaviour (guarded by a `fixes.<key>` flag) to `server/target.ts`, emitting a
   detection event.
2. Add a `FindingDef` to `FINDINGS` in `server/scenario.ts` (`confirmEvent`, severity, routes, impact,
   remediation **options with one `correct`**, `verifyRetest`, explanation).
3. Add `confirm:<id>` and `fix:<id>` objectives (auto-generated from `FINDINGS`) — add hints to `HINTS`.
4. Add a solver branch in `tests/helpers.ts` and assertions in `tests/engine.test.ts` (a positive
   reachability test and a negative "no false completion" test).

A second target (PayFlow, TeamDesk) is a new `TargetState` + handler + `FINDINGS`, reusing the engine,
auth, persistence, scoring and report infrastructure.
