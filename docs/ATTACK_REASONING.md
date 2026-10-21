# Attack Reasoning: AI-powered attack reasoning module (Phase 1, Cloud Security)

Status: built and tested (19 Oct 2026). Sections 1 to 7 were the plan; section 8 records what landed and how to operate and extend it.

## 1. What exists today and what is reused

| Area | Finding | Decision |
|---|---|---|
| `attack-reasoning/` (ar.threatready.io) | A thin Express + Vite SPA: platform shell, a static "coming soon" scenario catalogue, identity resolved through onboard, an internal summary endpoint for onboard that reports zeros. No database, no LLM, no worker. | Keep it as the product's SPA and its origin's gateway. Replace the catalogue landing with the domain landing page and add the assessment UI. Proxy `/v1/*` to the monolith so the browser still talks only to its own origin (CSP `connect-src 'self'`). |
| `InterviewPrep/` (`@threatready/api`) | The NestJS modular monolith the ADD describes: `LlmPort` + Anthropic adapter + deterministic fake adapter, the `llm_call_log` budget ledger, pg-boss worker with retry policy and dead-letter handling, Drizzle schema with RLS owner policies, versioned SQL migrations, route contracts in `packages/contracts` enforced by the global guard, and a skill graph whose `skill_evidence.source` enum already includes `'reasoning'`. | Build the `reasoning` module here, exactly where the ADD's module map (HLD-3) and L17b put it. No new service, database, queue or LLM integration. |
| Onboard | Registers the `reasoning` app, calls `ar/internal/v1/users/:id/summary` and `/ai-usage`. | Unchanged. The AR gateway answers those from the monolith's new reasoning internal endpoints. |

## 2. Architecture

```
browser (ar.threatready.io, /ar/)             attack-reasoning Express (AR gateway)                 @threatready/api (NestJS monolith)
  /ar/                 static SPA  ───────►  serves dist, resolves identity via onboard
  /v1/reasoning/*      JSON        ───────►  reverse proxy, cookie + Origin forwarded ───────────►  reasoning module (guard: identity, permission,
                                                                                                    rate limit, body schema; RLS below)
                                                                                                        │
                                                                                                        ├─ pg-boss: reasoning.generate, reasoning.evaluate
                                                                                                        ├─ LlmService → LlmPort (Anthropic / fake), ledger
                                                                                                        └─ PostgreSQL: reasoning_items / attempts / evaluations,
                                                                                                           llm_call_log, skill_evidence (source = reasoning)
onboard  ── /ar/internal/v1/users/:id/summary ──► AR gateway ── /internal/v1/reasoning/users/:id/summary ──► monolith
```

Locally the AR Vite dev server proxies `/v1` to the API on :3100; the Render single-origin gateway already routes `/v1/*` to the API; on the subdomain layout the AR Express server proxies. In every layout the SPA calls `/v1/reasoning/*` on its own origin. The monolith accepts the AR origin for state-changing requests through a new `ALLOWED_APP_ORIGINS` list (CORS and the Origin check in the guard).

## 3. Assessment workflow (one attempt = one generated question)

1. `POST /v1/reasoning/attempts { domain }` creates an attempt in state `generating` and enqueues `reasoning.generate` (idempotent key = attempt id).
2. Worker generation pipeline: pick a variation seed the user has not seen (topology × entry point × objective × technique, excluding recent fingerprints) → one LARGE structured call → code validation (schema, diagram integrity, four options with one correct, option-length tells, rubric completeness, narrative/diagram consistency, no answer-key leakage) → similarity check against the user's previous items (fingerprint collision and 3-gram Jaccard above the threshold reject) → on failure, regenerate with a new seed and the validation errors fed back, up to the configured limit → store `reasoning_items` (public and private halves) → attempt `ready`.
3. `GET /v1/reasoning/attempts/:id` returns the public half only: scenario, attack narrative, diagram data, objective, question, four options. Never the answer key, rubric, reference answer or option analysis.
4. `POST /v1/reasoning/attempts/:id/submit { selectedOption, justification, clientSubmissionId }`: a justification of at least 40 characters is required; the selected option and justification are stored separately; state `evaluating`; `reasoning.evaluate` enqueued. Idempotent on `clientSubmissionId`.
5. Worker evaluation pipeline (three stages, all LARGE, structured): evaluator → challenger (adversarial: hallucinated references, fluent-but-wrong, missing critical elements, contradiction with the selection) → reconciler (final per-point statuses and the candidate-facing feedback). Degraded paths: challenger fails → reconcile from the evaluator alone, confidence `low`, review flag, notice; reconciler fails → final statuses from the evaluator adjusted by the challenger, confidence `low`, review flag. Evaluator fails → job retry → dead letter → attempt `evaluation_failed` with a retry endpoint. Nothing is ever scored from a fabricated output.
6. Deterministic scoring in code (`scoring.ts`): schema-validated statuses → evidence-quote check (a point credited without a verbatim quote from the justification is downgraded to missed) → must-not-credit list → integrity rules (off-topic, grader instructions, contradiction with the selected option) → configured weights → clamp → total. Confidence from inter-stage disagreement. Stored with scoring, prompt and generator versions, model and tier.
7. `GET /v1/reasoning/attempts/:id/result` returns the feedback: decision, reasoning assessment, what you got right, what you missed, why the best answer works, why the alternatives are weaker, architecture analysis, score breakdown, how to improve, confidence and review flag.
8. Skill evidence (source `reasoning`) is written in the same transaction as the evaluation and `skills.recalculate` is enqueued. History: `GET /v1/reasoning/attempts`; analytics: `GET /v1/reasoning/dashboard`; domains: `GET /v1/reasoning/domains`.

## 4. Scoring model

Default weights (configurable per domain, and per generated question within bounds): selected-answer correctness 30, technical reasoning and evidence 40, attack-path and architecture understanding 20, risk awareness and trade-offs 10. Rules:

- Correctness: full points for the best option; a configurable fraction (default 25%) for an option the rubric marks `plausible`; none otherwise.
- Each reasoning dimension is the weighted mean of its rubric points (met = 1, partial = 0.5, missed = 0) times the dimension weight.
- A credited point whose evidence quote is not a verbatim substring of the justification becomes missed.
- A must-not-credit claim the justification asserts invalidates the points it lists.
- Confirmed technical errors deduct from the reasoning dimension (10% each, capped at 50%).
- A justification that argues for a different option than the one selected caps the reasoning dimension at 50%; off-topic or grader-instructing text scores 0 on every reasoning dimension and sets the review flag.
- A wrong selection caps the reasoning dimension at 60%: the reasoning led to the wrong decision.
- Length never adds points; only matched rubric points do.

So a correct guess with an empty justification scores at most 30; a correct answer with sound reasoning can reach 100; a fluent justification that contradicts the selection cannot score highly.

## 5. Schema (migration 0006)

- `reasoning_items`: id, org_id, user_id, domain, difficulty, fingerprint, seed (jsonb), public (jsonb), private (jsonb), weights (jsonb), generator_version, prompt_version, model, tier, created_at. RLS owner policy.
- `reasoning_attempts`: id, org_id, user_id, domain, state (`generating | ready | evaluating | evaluated | generation_failed | evaluation_failed`), item_id, selected_option, justification (≤ 4000), client_submission_id, submitted_at, generation_tries, failure_code, failure_stage, version, created_at, updated_at. RLS owner policy, unique (id, client_submission_id).
- `reasoning_evaluations`: id, org_id, user_id, attempt_id (unique), scoring_version, total_score (0–100 check), correct, dimensions (jsonb), feedback (jsonb), stages (jsonb: raw evaluator, challenger, reconciler outputs for audit), confidence, review_flag, degraded, prompt_version, rubric_version, model, tier, latency_ms, created_at. RLS owner policy.
- Grants to `tr_app_user`; existing `platform_llm_usage()` already covers the new `reasoning.*` features.

## 6. API (contracts in `packages/contracts/src/reasoning.ts`)

| Route | Permission | Rate class |
|---|---|---|
| `GET /v1/reasoning/domains` | reasoning:read | general |
| `POST /v1/reasoning/attempts` | reasoning:take | reasoning_create (10/h) |
| `GET /v1/reasoning/attempts` | reasoning:read | general |
| `GET /v1/reasoning/attempts/{id}` | reasoning:read | general |
| `GET /v1/reasoning/attempts/{id}/events` (SSE) | reasoning:read | general |
| `POST /v1/reasoning/attempts/{id}/submit` | reasoning:take | general |
| `POST /v1/reasoning/attempts/{id}/retry` | reasoning:take | general |
| `GET /v1/reasoning/attempts/{id}/result` | reasoning:read | general |
| `GET /v1/reasoning/dashboard` | reasoning:read | general |
| `GET /internal/v1/reasoning/users/{userId}/summary`, `/internal/v1/reasoning/ai-usage` | internal token | n/a |

## 7. Adding a domain

A domain is one file in `apps/api/src/modules/reasoning/domains/`: key, title, description, skill ids for evidence, the variation space (topologies, components, entry points, objectives, techniques, constraints), domain-specific generation guidance, default weights and difficulty. Register it in `domains/index.ts`. Generation, validation, similarity, evaluation, scoring, persistence, the API and the UI are domain-agnostic. The landing page lists every registered domain; unregistered ones show as coming soon.

## 8. As built

### Where the code is

| Piece | Path |
|---|---|
| Contracts (schemas, routes, limits) | `InterviewPrep/packages/contracts/src/reasoning.ts`, routes in `openapi/routes.ts` |
| Error codes | `InterviewPrep/packages/shared/src/errors.ts` (`REASONING_*`) |
| Schema and migration | `InterviewPrep/packages/db/src/schema/reasoning.ts`, `migrations/0006_attack_reasoning.sql` |
| Domain registry | `InterviewPrep/apps/api/src/modules/reasoning/domains/` (`cloud-security.ts`, `index.ts`) |
| Generation | `generation.service.ts` (worker), `prompts/generation.prompts.ts`, `validation.ts`, `similarity.ts`, `seed.ts` |
| Evaluation | `evaluation.service.ts` (worker), `prompts/evaluation.prompts.ts`, `scoring.ts` |
| API | `reasoning.service.ts`, `reasoning.controller.ts` (browser routes and the internal summary/usage routes) |
| Worker wiring | `modules/jobs/jobs.service.ts` (`reasoning.generate`, `reasoning.evaluate`, dead-letter, sweep) |
| Fake model for tests | `platform/adapters/fake/reasoning.fake.ts` |
| AR gateway | `attack-reasoning/server/proxy.ts`, `server/app.ts` (`/v1` proxy, internal proxying) |
| AR UI | `attack-reasoning/client/src/reasoning/` (`api.ts`, `Diagram.tsx`, `pages.tsx`), routes in `App.tsx` |

### Configuration

InterviewPrep API: `ALLOWED_APP_ORIGINS` (the AR origin), `REASONING_MAX_OPEN_ATTEMPTS` (3), `REASONING_MAX_GENERATION_TRIES` (3), `REASONING_SIMILARITY_THRESHOLD` (0.35). Attack Reasoning gateway: `REASONING_API_URL` (the InterviewPrep API; without it the catalogue still serves and `/v1` answers 503). Render (`deploy/start.mjs`) wires both automatically on one origin.

### What the real model does (one run, Sonnet 5.5, 19 Oct 2026)

| Step | Result |
|---|---|
| Generation | Valid on the first try: 9 components, 9 flows, 3-step attack path, 8 rubric points, four options of similar length. 79 s, US$0.094, 8.3k output tokens. |
| Evaluation | Evaluator 10 s, challenger 12 s, reconciler 18 s; US$0.09 for the three stages. |
| Scoring | A correct option with a generic justification scored 40/100 (30 for the decision, 3.5/30 reasoning, 6/30 architecture, 0/10 risk), confidence low, flagged for review. That is the intended outcome for a guess without scenario-specific reasoning. |

The per-objective weights are visible here: a "blast radius" objective weights architecture at 30 rather than the default 20. Generation at high effort exceeded the output budget and took several minutes; the shipped prompt uses medium effort with a 16k-token budget and tighter length guidance.

A second run through the browser (local stack, real model): the first attempt's three generations were each rejected by one validator rule and the attempt ended in `generation_failed` with a working Retry; the retry generated a valid item on its first try in 30 s (US$0.046). The validator reasons are now logged (`generated item rejected by validation` carries `reasons`), and a normalisation pass (`normaliseGeneratorOutput`) repairs the mechanical omissions that need no judgement before validation runs: attack-path edges not typed `attack`, a missing entry-point flag, the assigned technique missing from the list. The generated item ("Anonymous Bucket Read Leads to Integration Credentials": anonymous bucket read, leaked task-role session, secrets read, OAuth token replay) was coherent with its diagram; a reasoned correct answer scored 83/100 at medium confidence in 46 s of evaluation (US$0.09). Per attempt: about US$0.13-0.19 and 75-130 s of model time.

### Tests

- `apps/api/test/unit/reasoning.test.ts` (18): weights normalisation, every scoring rule (guess vs reasoned, wrong-option caps, quote withdrawal, must-not-credit, contradiction, technical errors, integrity, confidence, length independence), item validation (options, leaks, diagram integrity, narrative consistency, rubric shape), seed rotation and similarity, the domain registry.
- `apps/api/test/reasoning.e2e.test.ts` (14, PostgreSQL + fake model): the whole journey, answer-key secrecy in the public payload, mandatory justification, idempotent submission, three-stage ledger entries, skill evidence and recalculation, history and dashboard, guess vs reasoned vs wrong scoring, integrity rules, challenger withdrawals, uniqueness and forced-duplicate regeneration, invalid-item regeneration with feedback, degraded evaluation stages, dead-letter recovery with retry, budget exhaustion, ownership (404 for another user), origin policy, open-attempt limit, internal API scoping.
- `apps/api/test/security.e2e.test.ts`: the generated second-user test now covers the reasoning routes.
- `apps/api/test/reasoning.real.test.ts`: opt-in (`REAL_LLM=1`) run against Anthropic.
- `attack-reasoning/tests/api.test.ts` (12): the gateway with and without an engine, proxying of cookie, Origin, body and SSE, origin refusal, internal summary and usage from the engine, engine-down handling.
- Browser walkthrough on the local stack (`start-all.sh`): sign-up on onboard, domain landing, domain page, start, generating state, failed state with retry, scenario with diagram, option and justification form, evaluating state, result, history. A local test account for this lives in the gitignored `e2e/.env` (template `e2e/.env.example`).

### Operating notes

- Attempt states: `generating → ready → evaluating → evaluated`, with `generation_failed` and `evaluation_failed` reachable from the two transient states and recoverable through `POST /attempts/{id}/retry`. The sweeper marks a stage stuck for two hours as failed.
- Budget: generation reserves under the `new_interview` policy (global breaker, user-day and per-attempt caps); evaluation under `finalize` so a submitted answer always gets evaluated. A budget stop marks the attempt failed with the code (`LLM_BUDGET_EXCEEDED`, `AI_SERVICE_PAUSED`) rather than retrying.
- Metrics (CloudWatch EMF): `ReasoningGenerationMs`, `ReasoningGenerationRejected{Reason}`, `ReasoningGenerationFailed`, `ReasoningEvaluationMs`, `ReasoningEvaluationDegraded{Stage}`, `ReasoningReviewFlag`; every model call is in `llm_call_log` under `reasoning.generate|evaluator|challenger|reconciler`.
- Audit: `reasoning_evaluations.stages` keeps the validated outputs of all three stages; the private half of an item (`reasoning_items.private`) is never serialised to the browser (asserted by the end-to-end test on the raw response).

### Added 21 Oct 2026: difficulty, pre-generation, diagram layout

- **Difficulty per attempt.** `POST /attempts` and `/attempts/prefetch` take `difficulty` (beginner, intermediate, advanced; expert exists in the enum). The attempt stores it (migration 0007), the seed carries it, the generation prompt scales the architecture (component and boundary counts, a hidden trust relationship and a non-applicable control at advanced), the attack (step count) and the question (how defensible the distractors are). The validator enforces floors: advanced needs at least 3 attack steps and 9 components, beginner at most 2 steps. The domain page remembers the learner's choice per domain.
- **Pre-generation.** `POST /attempts/prefetch` keeps exactly one un-opened scenario per learner, domain and difficulty (`opened_at` null; a partial unique index in migration 0008 is the backstop). `POST /attempts` hands over the waiting scenario, marks it opened, and immediately pre-generates the next one; the attempt page also keeps the next one warm while the learner reads, answers and reviews. Un-opened scenarios are invisible in history and do not count towards the open-attempt cap. `POST /attempts/{id}/abandon` skips an unanswered scenario (state `abandoned`, shown as "Skipped"). The UI offers "Start now" when a scenario is waiting, "Skip to next scenario" on a question, and "Next question" on a result. `REASONING_PREFETCH_ENABLED=false` turns the behaviour off (tests run with it off except the dedicated prefetch test). Cost: one generation per question viewed, started a question early.
- **Diagram layout.** React Flow now renders a dagre layered layout (left to right, trust boundaries as clusters, `@dagrejs/dagre`); nodes cannot overlap, edges follow dagre's routed points and every label sits at the position dagre reserved for it. The canvas takes the graph's aspect ratio, the wheel scrolls the page (zoom via the controls or pinch), and fit-to-view runs on timers after mount.

### Known limits and next steps

- Generation takes about 30-90 s with the real model; the UI says so and the attempt survives a page reload. A streamed "scenario preview" is not implemented.
- Validator rejections cost a generation each (about US$0.05). Watch `ReasoningGenerationRejected` and the logged reasons; if one rule dominates, either teach the prompt or add a repair to the normalisation pass.
- The similarity check is lexical (word trigrams). It catches rephrasings of the same item; semantic near-duplicates with different vocabulary rely on the seed rotation.
- Difficulty is fixed per domain (Cloud Security: intermediate). The item carries a difficulty, and the generator takes a difficulty guide, so per-attempt difficulty selection is a small addition to the create request.
- The dispute button (ADD L17b) and the human-graded replay set are not built; `stages` holds what they need.
- Review-flagged results are visible to the learner with the flag; there is no reviewer queue yet.
