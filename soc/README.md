# SOC simulation

A standalone training simulator for SOC analysts. The analyst
watches a live log stream, picks up an alert, and works the ticket through
every tier:

    Monitor -> L1 triage -> L2 investigation -> L3 response -> Closure

There are three levels of twelve scenarios each (Foundations, Intermediate,
Expert). Logs are synthetic, generated per attempt, and consistent across
fourteen sources: proxy, DNS, email gateway, endpoint (Sysmon-style),
Windows Security, Windows System, firewall, tool audit, VPN, identity
provider (sign-ins and audit), file auditing, web server and WAF, Microsoft
365 mail audit, and AWS (CloudTrail and GuardDuty). Every attempt renames
people, hosts, addresses, domains, identifiers and hashes, so two attempts
at the same scenario never look the same. Answer keys never leave the
server until the ticket is closed.

There is no certificate. Each level has an internal badge (ten distinct
scenarios passed), which shows progress inside this simulation only. The
final analyst report is available to every user at any time, whatever
their results.

## Run it

Requires Node.js 18 or newer (22 recommended; `.node-version` pins 22).

    npm install --omit=dev     # server needs only express; the UI is prebuilt in client/dist
    npm start                  # http://localhost:4000

Open the page, enter an analyst name, and start. There is no account or
password: each sign-in gets its own private records, kept in that browser
for 24 hours or until sign-out, and all records reset daily at 00:00 UTC.

### Environment variables

None is required.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | – | `production` turns on secure cookies and ignores `DEV_USER`. |
| `SIM_SESSION_SECRET` | random at start-up in production | Signs the session cookie. Set it so sessions survive a restart. Server only. |
| `DAILY_WIPE` | `true` | Deletes all attempts, cases and badges at 00:00 UTC. |
| `PORT` | `4000` | Port to listen on. Render sets it automatically. |
| `SOC_SIM_DATA` | `data/cases.json` | Path of the case store; `attempts.json` and `awards.json` sit beside it. |
| `DEV_USER` | – | Development only: skips the sign-in page as this user. Ignored in production. |
| `TR_SIM_SECRET`, `TR_HOME_URL` | – | Optional. Only to also accept ThreatReady `?t=<token>` links (HS256, `aud` "soc-sim", see `signToken` in `server/auth.js`). Not needed for the standalone simulation. |
| `TR_WEBHOOK_URL`, `TR_WEBHOOK_SECRET`, `TR_EXPORT_TOKEN` | – | Optional record export to another system. Off unless set. |
| `SOC_INTERNAL_TOKEN` | – | Optional. 32+ characters: serves one analyst's progress summary at `GET /internal/v1/users/:uid/summary` (Bearer token) for a platform host. Inside ThreatReady the labs server reads the same summary in process. A token of its own: in production the platform's shared `INTERNAL_API_TOKEN` is refused here (the route stays off) unless `INTERNAL_TOKEN_LEGACY_ACCEPT=true`. |
| `SOC_MAX_STREAMS_PER_USER` | `3` | Live log streams one analyst may hold open at once (`0` = no limit; empty = the default). A reconnect from the same page replaces its own stream. |
| `TR_STATE_DURABLE` | – | Set by the ThreatReady launcher while it keeps the records across restarts. Inside ThreatReady the console then says records are saved to the ThreatReady account; otherwise that they are kept on the lab server. |

Secrets are read only on the server. The built client contains none of
them (`tests/bundle.test.mjs` checks).

### Develop

    npm install
    npm run dev:server         # API on :4000, restarts on change
    npm run dev:client         # Vite on :5173, proxies /api to :4000
    npm run build              # rebuild client/dist
    npm test                   # all suites, about 3 minutes (they wait for real alert timers)
    SCN=E7,E8 node --test tests/scenarios.test.mjs   # validate selected scenarios

All of these work the same in Windows PowerShell, cmd and Linux/macOS shells
(set environment variables the way your shell does).

## Deploy on Render

New > Web Service, pick the repository (or New > Blueprint, which applies
`render.yaml`).

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Environment | `NODE_VERSION=22`, `NODE_ENV=production`, optionally `SIM_SESSION_SECRET` |

Do not add `PORT`. Check after deploy: `/api/health` returns
`{"ok":true,...}` and the site opens on the sign-in page.

On the free plan the disk is not persistent: records are lost when the
service restarts or redeploys (they are wiped daily at 00:00 UTC anyway),
and the service sleeps when idle (the first request after that takes up to
about a minute).

### Avoiding merge conflicts

`client/dist` is generated. When two branches both rebuild it, Git reports
conflicts in its hashed file names. Resolve those by running
`npm run build` and committing the result, never by editing the files.
Before pushing, check that no conflict markers are left:

    git grep -n -E "^(<<<<<<<|=======|>>>>>>>)( |$)"

No output means it is clean.

## Levels and scenarios

| Level | For | Workflow | Pass mark | Rounds per stage | Hints |
|---|---|---|---:|---:|---|
| Foundations | Freshers, first SOC job | L1 triage, close or escalate | 60 | 3 (credit 100/70/40%) | Shown after a wrong answer |
| Intermediate | 6-18 months in L1 | L1, then L2 investigation | 70 | 2 (100/70%) | "Show hint" per question; caps it at 80% |
| Expert | L2/L3, incident responders | L1, L2, L3 response | 75 | 1 | None before the review |

Foundations is open. Intermediate opens with the Foundations badge, Expert
with the Intermediate badge. The server enforces this (403 `level_locked`).
Scenarios can be retaken without limit; each retake is a new variant. An
open attempt can be abandoned: it scores 0 and stays in the history.

The scenario catalogue is the "Scenario specifications" tab of the build
specification. `server/scenarios/foundations`, `intermediate` and `expert`
hold F1-F12, I1-I12 and E1-E12; F3, I1 and E1 reuse the original modules
(`s02-authfail.js`, the demo's portal scenario in normal mode, and
`s01-beacon.js`). Each one is validated by `tests/scenarios.test.mjs`: the
alert's matched events exist and exclude decoys, a scripted perfect run
scores 100 (renamed and canonical), and an always-wrong run scores below
the pass mark.

Level cards and scenario cards show only the alert title, never the story
behind it.

## Reports

- **After-action review** (every closed attempt, pass or fail): result
  banner ("Passed: 84 (pass mark 60)" or "Not passed: 52 (pass mark 60)"),
  new best or not, Skills tested, every answer with the expected answer and
  explanation, evidence feedback, response objectives and deductions, and
  what actually happened.
- **Final analyst report** (`#/report`): rebuilt from the records on every
  request. Status, summary, results by level, a 25-skill map ("Not enough
  evidence yet" until a skill has three questions across two scenarios),
  decision quality, strengths, gaps or missed decisions, what to learn next,
  and the attempt history including failed and abandoned attempts. Print or
  save as PDF (A4), and download the JSON record (`GET /api/me/export`).
- **Internal badges** (`#/badges`): one per level, with the date, average
  and passed count frozen when earned. A dialog announces a new badge; after
  Expert it reads "All three SOC Simulation levels completed. Your internal
  Expert badge has been earned."

## For beginners: Newbie Demo Mode and the walkthrough

The home page has a "New here?" section with two optional entry points.
Neither is gated, neither counts towards a level, and neither changes how
the level scenarios behave.

| Entry point | What it is | What it creates |
|-------------|------------|-----------------|
| **Newbie Demo Mode** ("Start guided demo", `#/demo`) | A guided run of one ticket from the first log line to the closed ticket, in 16 steps. An instructor panel points an arrow at each control, explains what it is, why it matters and what to do, and checks the work on the server before the learner can continue. | One demo session on a dedicated sample scenario (`demo-portal-login`). Ticket numbers start with `DEMO-`. It is not listed under Recent attempts and does not use assessment ticket numbers. |
| **Take a walkthrough** ("How it works") | A 13-step tour of the interface: home page, console, logs, search, the three tiers and the report. | Nothing. Console screens are shown on read-only sample tickets the server keeps in memory. |

A demo session can be paused, exited, resumed after a refresh or a later
visit (kept for 24 hours), replayed, or restarted clean. Its result is
labelled a guided learning summary, not an assessment.

`docs/BEGINNER_MODE.md` is the implementation report: files, the guided
sequence, how validation and isolation work, and the test results.

## How it works

    server/
      index.js              HTTP API + SSE stream; serves client/dist; daily wipe
      config.js             environment configuration (server only)
      auth.js               token hand-off, session cookie, /api/session, /api/me
      levels.js             levels, pass marks, rounds, decay, hints, unlock rules, skills
      attempts.js           attempt lifecycle, level state, badges, skill scores, metrics
      repo.js               attempts.json and awards.json
      store.js              JSON-file case store (atomic writes)
      report/               final analyst report and recommendations
      engine/
        alias.js            per-attempt renaming (out to the analyst, in from the analyst)
        pools.js            name, domain and address pools for renaming
        env.js              the simulated company: hosts, users, service accounts, baselines
        format.js           log line builders (raw line + parsed fields)
        noise.js            background activity, a pure function of (seed, second)
        logstream.js        per-case stream: history + one slot per elapsed second
        query.js            search language (field:value, wildcards, -exclude, a>n, (a|b))
        cases.js            workflow state machine, grading, public serialisation
        grading.js          per-field grading against the private key
        tools.js            threat intel, asset, directory, change calendar, decode, sweep, process tree, sandbox
        response.js         response actions, environment state, objective evaluation
        report.js           after-action report and Markdown export
        common.js           shared scenario helpers (beacon generator)
      scenarios/            lib.js (defineScenario) and foundations/, intermediate/, expert/
                            (demo-portal.js is the demo scenario; legacy.js wraps s01, s02 and the demo as E1, F3, I1)
      demo/
        guide.js            Newbie Demo script (public) and its checks (server only)
        service.js          demo sessions, progress, learning summary
        autoplay.js         read-only sample tickets for the walkthrough
        routes.js           /api/demo and /api/tour
    client/src/             React UI (Vite): Console.jsx is the SOC home; pages/ has the level,
                            badges and report pages
      tour/                 GuidedTour (reusable), HomeTour, DemoPage, DemoIntro, DemoSummary, Quiz
    tests/                  node:test suites driving the real API (run.mjs lists them for npm test)
    render.yaml             Render Blueprint (build, start, health check, Node version)
    docs/                   BEGINNER_MODE.md

**Real-time logs.** Each attempt has a random seed and a start time. Every
one-second slot is generated deterministically from them, so history (30 to
45 minutes before the shift) and the live tail come from the same function
and a case can be regenerated exactly after a restart. Scenario events are
scheduled into slots; periodic behaviour (beacons) is computed per slot and
consults the response state in force at that second. Blocking a domain
turns the next beacon into a DENIED proxy line; isolating a host replaces it
with an EDR "blocked" event; eradication stops it.

**Hidden answers.** Every gradable field carries a private `key` object
(accepted values, supporting-evidence tags, hint, explanation). The
serialiser in `cases.js` strips `key` from everything sent to the browser,
log events are sent without their `_tags`, and response objectives live
under `scenario.secret`. `tests/` scans every response of an open case for
those properties and for explanation text. Feedback before closure is
verdict-only (accepted / partly accepted / not accepted, plus a hint that
points at where to look).

**Evidence-backed findings.** Investigation findings must be linked to a
pinned log event. A correct answer whose linked event does not show it
earns 70%. Three review rounds; accepted findings lock; credit decays
(100 / 70 / 40%).

**Case history.** Every acknowledgement, pin, indicator, tool run,
submission, QA overrule, response action and tier reassignment is appended
to `case.history` with actor and timestamp, and stays visible in every
later stage and after closure. Completed stages can be reviewed from the
stage rail.

**Tier gating** is enforced on the server: fleet sweep, process tree and
sandbox need Tier 2; response actions need the L3 response stage; a closed
case is read-only.

## Adding a scenario

Write a module with `defineScenario()` from `server/scenarios/lib.js` in
the level's folder and add it to that folder's `index.js`. The helper builds
the standard stages for the level (stage weights from the specification),
the alert, the tools' records and the response objectives from a compact
definition: `build(x)` adds tagged events with `x.add(tag, E.<source>(...))`
at offsets from the alert (`x.T(seconds)`), `triage` / `l2` / `response` /
`closure` hold the questions with their keys, hints and explanations, and
`truth` is the story revealed at closure. List the scenario's external
domains, addresses, identifiers and names under `entities` so they are
renamed per attempt. `test` gives the tool runs, searches and response
actions of a perfect run; `SCN=<code> node --test tests/scenarios.test.mjs`
then proves every answer is supported by the generated logs.

## Limits to know about

- Records live in JSON files on one instance and are wiped daily at 00:00
  UTC (`DAILY_WIPE`). Use one instance; replace `server/store.js` and
  `server/repo.js` with a database adapter for anything larger.
- Renaming covers people, hosts, internal addresses, the scenario's
  external domains, addresses, identifiers, names and every SHA-256.
  Process ids, ports and file names are not renamed.
- I1 (the original demo scenario in normal mode) and E1 (the original
  beacon scenario) keep their own stage layouts, with separate escalation,
  validation and, for I1, response stages, rather than the standard layout
  for their level. Level rounds, decay and hints still apply.
- Free-text notes and summaries are recorded and length-checked, not graded
  for content.
- A live case stops generating new log lines six hours after it starts.
- Active time counts only while the console is open and visible (heartbeat
  every 30 seconds). There is no timed mode.
- The name sign-in is not authentication: anyone with the URL can sign in
  under any name. Records are private per sign-in (a random id in a signed
  cookie), not per name; signing out or clearing cookies loses access to
  them. Put it behind your own access control if that matters.
- Demo sessions are removed 24 hours after they start. Walkthrough sample
  tickets live in memory only and are rebuilt every 20 minutes.
- In Newbie Demo Mode the investigation summary is checked for its six
  parts by key words. That check cannot judge whether the reasoning is
  right, and says so.
- All organisation data is fictional. External infrastructure uses the
  reserved `.example` TLD and documentation or benchmarking IP ranges;
  benign destinations in the noise use those too, so a `.example` suffix
  is not a tell. Nothing calls a real cloud, identity, mail or security API.
