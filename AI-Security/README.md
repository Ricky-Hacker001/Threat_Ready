# AI Security Lab — ThreatReady

A standalone, **fully-simulated** AI/LLM security training range. An **Aerovant Technologies · ThreatReady** product.

Learners attack **Aero**, the AI assistant of a fictional fintech **AeroPay**, then detect, fix, re-test and report — the full `ATTACK → DETECT → FIX → RE-TEST → REPORT` loop across **10 attack types × 3 levels (30 scenarios)**.

> Nothing here is real. No external LLM is called, no payload executes, all data is synthetic, and every attack is scripted and deterministic. XSS / SQL / exfiltration / malicious-plugin / model-supply-chain outcomes are **demonstrated**, never run.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build (deployable as a static site, e.g. Render static site):

```bash
npm run build      # outputs to dist/
npm run preview    # serve the build locally
```

Tests:

```bash
npm test           # engine, routing, progress, store + 30-scenario acceptance tests
# Inside-ThreatReady browser checks (mocked /labs/api/me; Playwright from ../e2e/node_modules or PLAYWRIGHT_MODULE):
npx vite build --base /labs/aisec/ --outDir /tmp/aisec && node tests/browser.e2e.mjs /tmp/aisec
npm audit --omit=dev   # what ships to the browser: expected to report 0 vulnerabilities
```

## Deploy on Render

This is a Vite SPA. It can run either way:

**Inside ThreatReady** (production): `deploy/build.sh` builds it with `--base /labs/aisec/` and the Labs app serves
`dist/` behind the platform sign-in. Nothing here runs a server.

**Local preview server:** `npm start` runs `node server.js`, which serves `dist/` on `$PORT` (`vite preview` blocks
unknown hosts). It is a development convenience only: Express is a devDependency (so `npm audit --omit=dev` covers
just what ships to the browser), and `server.js` refuses to start with `NODE_ENV=production`.

**As a Static Site** (simpler, if your plan allows it):

- Build Command: `npm install && npm run build`
- Publish Directory: `dist`

## What's inside

- **Deterministic engine** (`src/engine`): simulated Aero brain, pipeline runner, seeded randomiser, event logger (500+ noise events/scenario), structured detection-rule evaluator, validation + re-test, scoring, progress store, admin-feed adapter.
- **10 tasks × 3 levels** (`src/scenarios`): each scenario is **data** — attack + bypass variants, accepted evidence, required controls, wrong-layer controls, benign tests, framework mappings. Add a scenario by adding config, not code.
- **Screens** (`src/screens`, `src/components`): Mission Control, Briefing, the AeroPay target app (chat + attacker workbench + role switcher), interactive architecture map, AI logs console with evidence marking, guardrail panel, detection-rule builder, re-test runner, expert report, results with **real PDF export**.
- **Navigation and resume** (`src/state`): each screen has a hash route (`#/mission`, `#/scenario/T1-F/logs`, `#/results/T1-F`…), so browser Back/Forward move between screens. The attempt in progress (evidence, guardrails, chat, re-tests) is saved next to progress — per ThreatReady account — so a reload resumes it, and Mission Control offers **Resume** after leaving it.

## Branding

All product/brand strings are centralised in `src/brand/brand.ts` (product name is configurable). The Aerovant logo (background removed to transparent PNG) ships in `src/assets`.

## Scoring (per the design doc)

100 points/scenario — attack reproduced, evidence, detection rule (I/E), fix at correct layer, re-test pass, benign intact, expert report (E). Deductions for hints, wrong-layer fixes, over-blocking and repeated failed re-tests. Pass mark 70. Badges: **AI Security Foundations / Practitioner / Expert** (all 10 tasks at a level ≥ 70). A failed scenario still produces its result and report: after a failed re-test the learner can **Finish anyway**, and the attempt is recorded as not passed ("Re-test failed") whatever its points. Only passed scenarios add to the accumulated score. Discarding an unfinished attempt that ran a re-test still counts as an attempt, and its re-tests count towards the re-test allowance of the next attempt at that scenario.

See `IMPLEMENTATION_STATUS.md` for what is complete and what remains.
