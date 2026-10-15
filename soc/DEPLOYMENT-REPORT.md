# SOC Simulation v2: implementation and deployment report

Base: `PRABU-S-19/soc` at `2a2eacb` (identical to the supplied
`soc-mainBackup.zip`). Work is on branch `v2`. Specification: the master
build prompt, the Build specification and its "Scenario specifications" tab.

**Deployment.** The user deployed to Render (repo `PRABU-S-19/SOC-updated`).
The first deploy built but refused to start because the then-required
ThreatReady secrets were missing; the simulation was then made standalone
(no ThreatReady link, no required variables). The steps to deploy are
in the README ("Deploy on Render").

## What was built, by phase

| Phase | Delivered |
|---|---|
| 1. Identity and attempts | Standalone name sign-in (`POST /api/session/local`, a private random user id per sign-in, signed HttpOnly cookie for 24 h, Secure in production) with sign-out; optional ThreatReady token hand-off only when `TR_SIM_SECRET` is set; `DEV_USER` outside production only; per-user ownership on every attempt, case and badge (404 otherwise); attempts store; daily wipe at 00:00 UTC. No environment variable is required |
| 2. Levels and SOC home | `server/levels.js` as the single source of level rules; server-side `levelState`; SOC home with name chip, level cards, Continue, Your record, Recent attempts (20 + Show more, abandon only open), reset note, footer; level pages with state and source filters (AND, with counts), Foundations demo banner, locked read-only view, Resume / Abandon-and-restart prompt |
| 3. Randomised variants | Per-attempt seed; renaming of people, hosts, internal addresses, scenario domains, addresses, identifiers, names and SHA-256s, consistent in logs, tools, alerts, search, sweep and answers; count and timing jitter; option order shuffled per attempt |
| 4. Level grading | Rounds and decay by level (3: 100/70/40, 2: 100/70, 1), automatic hints (Foundations), requested hints with 80% cap (Intermediate), `hints_off` (Expert), missed stages scored zero, collateral penalty 5 points per action capped at 20, half-up rounding, proportionality question on response stages |
| 5. Badges and reports | Badge at 10 distinct passes per level, awarded once; badge dialog (no certificate, Expert completion line); `#/badges`; after-action review with result banner, best-score line, Skills tested and footer buttons; final analyst report with all nine sections for every outcome, print to A4 and JSON export |
| 6. New log sources | VPN, identity provider (sign-ins and audit), Windows System, file auditing, web server and WAF, Microsoft 365 mail audit, AWS CloudTrail and GuardDuty, plus DNS daily statistics; each with noise and a source label |
| 7. Scenario library | 36 scenarios (F1-F12, I1-I12, E1-E12) from the catalogue; F3, I1 and E1 reuse the existing modules |
| 8. Regression | Full test suite, bundle leak test, browser scripts and screenshots (below) |

No certificate exists anywhere: no route, record, panel, print page,
download or verification path. The one unused `/verify/` allowance in the
session check was removed. The only occurrences of "certification" in the
built client are "not a certification" disclaimers (checked by a test).

## Commands actually run (Linux, Node 22.22.0)

| Command | Result |
|---|---|
| `npm test` | 93 tests, 93 passed, 0 failed (about 3 minutes) |
| `SCN=<code> node --test tests/scenarios.test.mjs` for every new scenario | Each passed: perfect run 100 (renamed and canonical), always-wrong run below the pass mark |
| `npm run build` | Built without errors |
| `node --test tests/bundle.test.mjs` | Passed: no scenario story, explanation, hint, objective text, secret name or certificate feature in `client/dist` |
| `NODE_ENV=production node server/index.js` with no secrets | Refused: "missing TR_SIM_SECRET, SIM_SESSION_SECRET, TR_HOME_URL" |
| Same with secrets and `DEV_USER` set | Started; logged "DEV_USER is set but ignored in production"; `/api/health` 200; `/api/me` and `/api/levels` 401; `/api/session/info` reports `signedIn: false` |

### Real browser (Chromium via Playwright, development server)

- SOC home, level pages (open and locked), filters, badges page, report
  page (no attempts, then one failed attempt), case console with level chip
  and "Back to level", phone width (390 px): rendered, no console errors.
- A Foundations attempt answered wrongly to closure: the review opens with
  "Not passed: 9 (pass mark 60)", "New best for this scenario", Skills
  tested and the footer buttons; the final report shows the real score,
  missed decisions and practice recommendations.
- Badge dialog: rendered with an injected Expert award (the earn path itself
  is covered by the API tests); shows the completion line, no certificate
  button.
- Token hand-off against a server with `TR_SIM_SECRET`: no token shows the
  ThreatReady page; a valid token signs in, shows the name and removes `?t=`.
- `tests/ui/homepage-tour.mjs`, `edge-cases.mjs`, `summary-actions.mjs`,
  `guided-demo.mjs` (Newbie Demo Mode 16 steps and the walkthrough): all
  completed with no page errors after updating their selectors to the new
  home page.

## Render settings

Build `npm ci --include=dev && npm run build`, start `npm start`, health
check `/api/health`, `NODE_VERSION=22`, `NODE_ENV=production`. Optional:
`SIM_SESSION_SECRET` (Render generates it from `render.yaml`) so sessions
survive restarts.

## Not verified, and limitations

- The optional ThreatReady token path was tested only with tokens signed by
  `signToken`, not against a real issuer.
- Name sign-in is not authentication; anyone with the URL can use it.
- The admin-portal webhook and pull export are implemented but were not
  exercised against a real endpoint (none exists). They stay off unless
  their variables are set.
- Earning a badge in the browser by passing ten scenarios by hand was not
  done; badge award, once-only award, unlock and dialog data are covered by
  API tests.
- Process ids, ports and file names are not renamed per attempt.
- I1 and E1 keep their original stage layouts (see README).
- Records are JSON files on one instance; Render's free disk is not
  persistent, and all practice records are wiped daily at 00:00 UTC.
- Free-text answers are length-checked, not graded for content.
