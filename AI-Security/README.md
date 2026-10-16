# AI Security Lab — ThreatReady

A standalone, **fully-simulated** AI/LLM security training range. An **Aerovant Technologies · ThreatReady** product.

Learners attack **Nova**, the AI assistant of a fictional fintech **AeroPay**, then detect, fix, re-test and report — the full `ATTACK → DETECT → FIX → RE-TEST → REPORT` loop across **10 attack types × 3 levels (30 scenarios)**.

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
npm test           # 197 engine + 30-scenario acceptance tests
```

## Deploy on Render

This is a Vite SPA. It can run either way:

**As a Web Service** (what this repo is set up for — a long-running Node process serves the built `dist/`):

- Build Command: `npm install && npm run build`
- Start Command: `npm start`   ← runs `node server.js`, which serves `dist/` and binds to `$PORT`

`npm start` must be the Start Command. If the Start Command is left as `npm run build`, the build just runs again and exits, so the deploy never comes up — that is the usual "it built but won't start" symptom. `server.js` (Express) is used instead of `vite preview` because `vite preview` blocks unknown hosts like `*.onrender.com`.

**As a Static Site** (simpler, if your plan allows it):

- Build Command: `npm install && npm run build`
- Publish Directory: `dist`

## What's inside

- **Deterministic engine** (`src/engine`): simulated Nova brain, pipeline runner, seeded randomiser, event logger (500+ noise events/scenario), structured detection-rule evaluator, validation + re-test, scoring, progress store, admin-feed adapter.
- **10 tasks × 3 levels** (`src/scenarios`): each scenario is **data** — attack + bypass variants, accepted evidence, required controls, wrong-layer controls, benign tests, framework mappings. Add a scenario by adding config, not code.
- **Screens** (`src/screens`, `src/components`): Mission Control, Briefing, the AeroPay target app (chat + attacker workbench + role switcher), interactive architecture map, AI logs console with evidence marking, guardrail panel, detection-rule builder, re-test runner, expert report, results with **real PDF export**.

## Branding

All product/brand strings are centralised in `src/brand/brand.ts` (product name is configurable). The Aerovant logo (background removed to transparent PNG) ships in `src/assets`.

## Scoring (per the design doc)

100 points/scenario — attack reproduced, evidence, detection rule (I/E), fix at correct layer, re-test pass, benign intact, expert report (E). Deductions for hints, wrong-layer fixes, over-blocking and repeated failed re-tests. Pass mark 70. Badges: **AI Security Foundations / Practitioner / Expert** (all 10 tasks at a level ≥ 70). A failed scenario still produces its result and report.

See `IMPLEMENTATION_STATUS.md` for what is complete and what remains.
