# Implementation status

Honest account of what is built, verified, and still outstanding against the master build prompt.

## Complete and verified

- **Shared deterministic engine** — simulated Aero brain, pipeline runner, seeded randomiser, event logger with ≥500 noise events/scenario, structured (no-`eval`) detection-rule evaluator, validation/re-test, scoring, progress store, admin-feed adapter.
- **All 30 scenarios** (10 tasks × Foundation/Intermediate/Expert) as data-driven config, with attack + bypass variants, accepted evidence, required controls, wrong-layer controls, benign tests and OWASP/ATLAS/ISO mappings.
- **Full workflow**: Mission Control → Briefing → Workspace (target app, architecture map, logs, guardrails, detection, re-test, expert report) → Results.
- **Scoring, deductions, pass mark, badges, per-task unlock** (configurable: per-task or all-foundations-first).
- **Architecture map** behaviour by level (Foundation highlight, Intermediate fix-node click scored, Expert hidden + path reconstruction).
- **AI logs console** with search, type/severity filters, pagination, detail drawer, evidence marking scored against accepted tags.
- **Guardrail panel** — every control changes engine behaviour; wrong-layer and over-block tracked.
- **Detection-rule builder** — structured conditions, AND/OR, aggregation + time window, test against synthetic logs, judged vs scenario targets.
- **Re-test runner** — original attack + bypass variants (by level) + chained path (Expert) + benign suite; pass only if attacks contained AND legitimate traffic intact.
- **Results** with full breakdown, explanations, and a **real downloadable per-scenario PDF** (jsPDF, ThreatReady/Aerovant branded).
- **Local persistence** (localStorage with in-memory fallback) + reset. The attempt in progress is saved too (per ThreatReady account), so reload resumes it; screens are hash routes, so Back/Forward stay in the lab. Inside ThreatReady, if the signed-in user can't be confirmed within ~5 s, progress is kept for that tab only (with a notice) instead of under a shared key.
- **Logo** processed to transparent-background PNG (navy + white variants).

### Testing

- **202 automated tests**: 18 targeted engine tests, 3 hash-route tests + a generic acceptance suite asserting, for every one of the 30 scenarios, that the primary attack is vulnerable pre-fix, the intended fix contains the primary + all exercised bypasses, benign traffic is not over-blocked, a wrong-layer control alone does not contain the attack, and required controls cover every variant.
- **Browser smoke tests** (Playwright) drove two different task shapes end to end (Task 1 prompt-leak, Task 6 refund tool-call): attack → evidence → guardrails → re-test → results, with no console errors.

## Added in later passes

- **Rebrand**: assistant renamed Nova → **Aero** throughout; Aerovant favicon; SIMULATION pill removed; change-name / back path from the header.
- **Badges**: 10 per-task appreciation badges + 3 tier medals, a dedicated showcase with locked state and progress bars, and a **badge-unlock celebration toast** on completion.
- **Learning Notebook** (expanded): a full study guide — Foundations (what an LLM / RAG / agent / guardrail is, the defender's loop, the frameworks), a glossary, and a per-task deep dive (plain-terms theory, how it works, a hands-on walkthrough, attack/fix flow diagram, why it matters, detect, fix, common mistakes). Readable in-app and as a downloadable PDF (~300 KB).
- **Bundle**: jsPDF is now lazy-loaded as a separate chunk; main bundle ~346 KB. PDF logo downscaled.

## Simplified / outstanding (next pass)

1. **Target-app sub-views**: attacks run from the attacker workbench via scenario templates. Dedicated interactive **Document Upload**, **Support Inbox**, **Plugin Store**, **Model Registry** and **live cost meter** views are simplified — the scenarios are fully playable without them, but these screens are not yet first-class.
2. **Newbie Demo Mode**: the button currently launches the Task 1 Foundation guided walkthrough rather than a dedicated 10-step overlay tour.
3. **Final cumulative analyst report**: per-scenario PDF + the learning notebook PDF are done; the cumulative analyst report (10×3 heatmap, skill radar) is not yet built.
4. **Admin feed**: adapter + local sink implemented; no real ThreatReady portal endpoint is wired (by design — needs credentials/URL).

None of the above blocks the core training loop: a learner can open Mission Control, pick any of the 30 scenarios, run the simulated attack, investigate, fix at the correct layer, re-test, and get a scored result and (Expert) report.
