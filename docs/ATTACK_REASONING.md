# Attack Reasoning: AI-powered attack reasoning module (Phase 1, Cloud Security)

Status: built and tested (19 Oct 2026); budgets, limits and the pool revised after the 23 Oct 2026 security audit. Sections 1 to 7 were the plan; section 8 records what landed and how to operate and extend it. Where an older dated note below disagrees with "Budgets, limits and costs (23 Oct 2026)", the latter is current.

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

InterviewPrep API: `ALLOWED_APP_ORIGINS` (the AR origin), `REASONING_MAX_OPEN_ATTEMPTS` (3), `REASONING_MAX_GENERATION_TRIES` (3), `REASONING_SIMILARITY_THRESHOLD` (0.35), and the budget, limit and pool settings listed under "Budgets, limits and costs (23 Oct 2026)". Attack Reasoning gateway: `REASONING_API_URL` (the InterviewPrep API; without it the catalogue still serves and `/v1` answers 503), `AR_RATE_PER_MIN` (120), `AR_RATE_IP_PER_MIN` (300), `AR_IDENTITY_MAX_IN_FLIGHT` (50), `AR_IDENTITY_MAX_PER_CLIENT` (16), and standing alone `AR_TRUST_PROXY` and `AR_TRUST_CLIENT_IP_HEADER` (see `.env.example`). Render (`deploy/start.mjs`) wires both automatically on one origin.

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
- Budget: see "Budgets, limits and costs (23 Oct 2026)" below. In short: a question is handed out and an answer accepted only when the learner's budget and the global breaker allow its evaluation (refused up front with 429/503, the answer unsent); evaluation stage 1 and on-demand generation run under the `reasoning` policy (learner's daily cap plus breaker), stages 2-3 under `finalize` (breaker with 10% grace), pool generation under `pool`. A budget stop that still happens in flight marks the attempt failed with the code (`LLM_BUDGET_EXCEEDED`, `AI_SERVICE_PAUSED`) rather than retrying, and retrying it later does not count against the retry limit.
- Metrics (CloudWatch EMF): `ReasoningGenerationMs`, `ReasoningGenerationRejected{Reason}`, `ReasoningGenerationFailed`, `ReasoningEvaluationMs`, `ReasoningEvaluationDegraded{Stage}`, `ReasoningReviewFlag`; every model call is in `llm_call_log` under `reasoning.generate|evaluator|challenger|reconciler`.
- Audit: `reasoning_evaluations.stages` keeps the validated outputs of all three stages; the private half of an item (`reasoning_items.private`) is never serialised to the browser (asserted by the end-to-end test on the raw response).

### Added 21 Oct 2026: difficulty, pre-generation, diagram layout

- **Difficulty per attempt.** `POST /attempts` and `/attempts/prefetch` take `difficulty` (beginner, intermediate, advanced; `expert` is accepted by the contract, served from the advanced pool and recorded as `advanced`, so the level shown is the level served). The attempt stores it (migration 0007), the seed carries it, the generation prompt scales the architecture (component and boundary counts, a hidden trust relationship and a non-applicable control at advanced), the attack (step count) and the question (how defensible the distractors are). The validator enforces floors: advanced needs at least 3 attack steps and 9 components, beginner at most 2 steps. The domain page remembers the learner's choice per domain.
- **Pre-generation (superseded by the shared pool below).** `POST /attempts/prefetch` kept exactly one un-opened scenario per learner, domain and difficulty (`opened_at` null; a partial unique index in migration 0008 is the backstop). `POST /attempts` hands over the waiting scenario, marks it opened, and immediately pre-generates the next one; the attempt page also keeps the next one warm while the learner reads, answers and reviews. Un-opened scenarios are invisible in history and do not count towards the open-attempt cap. `POST /attempts/{id}/abandon` skips an unanswered scenario (state `abandoned`, shown as "Skipped"). The UI offers "Start now" when a scenario is waiting, "Skip to next scenario" on a question, and "Next question" on a result. `REASONING_PREFETCH_ENABLED=false` turns the behaviour off (tests run with it off except the dedicated prefetch test). Cost: one generation per question viewed, started a question early.
- **Diagram layout.** React Flow now renders a dagre layered layout (left to right, trust boundaries as clusters, `@dagrejs/dagre`); nodes cannot overlap, edges follow dagre's routed points and every label sits at the position dagre reserved for it. The canvas takes the graph's aspect ratio, the wheel scrolls the page (zoom via the controls or pinch), and fit-to-view runs on timers after mount.

### Added 21 Oct 2026: shared question pool (replaces per-learner pre-generation)

- **Pool.** Questions are generated ahead of time per domain and difficulty and stored once (`reasoning_items.pool = true`, no owner; migration 0009). Starting a question picks a random pool question the learner has never been served (`ORDER BY random()` over the bucket, excluding `reasoning_served`), records it in `reasoning_served`, and returns it ready: about 60 ms instead of 30 to 90 s. A learner never gets the same question twice, including skipped ones; other learners get the same questions in their own random order.
- **Refill.** Demand-driven since 23 Oct 2026 (see "The question pool" below): buckets served in the last week are kept at `REASONING_POOL_TARGET` (12), the others at `REASONING_POOL_IDLE_TARGET` (2), up to `REASONING_POOL_BATCH` (4) generated in parallel per run. It runs on worker start and every 15 minutes (only for buckets short of their target), and when a learner's unseen count for a bucket runs low (up to the target only). One refill per bucket at a time (session advisory lock). Each new question is validated and checked for similarity against its bucket, including the others in the same parallel batch. Measured locally: 4 questions per level in 100 to 150 s.
- **On demand only as a fallback.** When a learner has seen every question in a bucket, one is generated for them and joins the pool for everyone else.
- **Cost ownership.** Pool generation is recorded in the AI ledger under the platform account `threatready-reasoning-pool` with its own daily cap (`REASONING_POOL_DAILY_CAP_USD`, default 5) plus the global breaker. On-demand generation (a learner who has seen the whole bucket) is billed to that learner's daily cap since 23 Oct 2026, and evaluation stays on the learner.
- **Levels.** The selected level is the level served: buckets are per difficulty and the request states hard shape limits per level. Measured pool averages: beginner 6.8 components, 2.0 attack steps, 3 boundaries, 6 rubric points; intermediate 9.8, 3.3, 4.3, 8; advanced 12.3, 3.8, 5, 9. The validator rejects items below a level's floor (beginner at most 2 steps; intermediate at least 2 steps and 6 components; advanced at least 3 steps and 9 components). The domain page now offers "Continue" only for an unfinished question at the selected level (previously any level, which reopened an Intermediate question after choosing Beginner or Advanced), and its header shows the selected level.
- **Open-attempt cap.** Starting a new question at the cap skips the oldest unanswered question instead of refusing; only answers under evaluation block a new start. Because that skip counts as 0, the start is first refused with 409 `REASONING_SKIP_CONFIRMATION_REQUIRED` (naming the question it would skip); the client asks the learner and repeats the start with `skipOldest: true` only on a yes. The refused start counts against `REASONING_RATE_CREATES_PER_HOUR` like any other.
- **Generation repairs.** Attack paths listed out of order but forming one chain are reordered before validation.

### Added 21 Oct 2026: ending an assessment

An assessment is a session: it starts with Start (or Continue) on a domain page, and Next question and Skip continue it. "End assessment" is on the question, while an answer is evaluating, while a question is generating, and on the result. Ending on an unanswered question asks for confirmation and skips it; ending while an answer is evaluating keeps that answer, which finishes in the background. The learner lands on `/ar/summary?domain=…&since=…`: questions answered, average and best score, correct decisions, a trend, and every question of the session with its level, state and score (refreshing while any answer is still evaluating), with links to start a new assessment or open the full history. The session is held in the tab's sessionStorage; the summary reads its start from the URL, so it can be reopened.

### Added 22 Oct 2026: all fifteen domains live

The domain package (`attack-reasoning-domains.zip`) was merged: 14 new definition files under `modules/reasoning/domains/` (Identity & Access, Application Security, Network Security, Security Operations, Incident Response & DFIR, DevSecOps & Supply Chain, Container & Kubernetes, Data Security & Privacy, Threat Intelligence & Hunting, Endpoint Security, Zero Trust, API Security, AI & LLM Security, GRC & Risk) and the registry that lists all 15. Engine changes from the package: a per-domain technique framework (`framework`, default ATT&CK Enterprise; AI & LLM Security uses MITRE ATLAS, ids like `AML.T0051`) used by the validator and the prompt; an optional per-domain `framing`; generator version `gen.v2.2026-10-21`; new diagram node types (endpoint, container, pipeline, repository, model, device, email, siem, saas) and boundary kinds (cluster, corporate, ot, tenant, vendor) with glyphs and colours; two skills (`iam.federation`, `iam.privileged_access`). Every replacement file was diffed against the current code before copying; each only changed the lines it intended, so the pool, the levels and End assessment are intact.

Integration changes beyond the package: the scheduled refill now fans out into one short job per domain and difficulty (intermediate first for every domain, then beginner, then advanced), because one job walking 45 buckets would outlive its 30-minute expiry; and the attempt, summary and history pages show the domain's title ("AI & LLM Security") instead of a name built from its key.

Verified: 164 API tests (including a smoke test that generates and validates a fake item for every domain at every level) and 12 gateway tests pass; in the browser all 15 domains are live, and a real-model AI & LLM Security question generated on demand with ATLAS techniques and a "model" node in its diagram.

Cost to stock every bucket: measured about US$0.15 per accepted question including rejected tries (more than the package's US$0.05 estimate), so filling 14 new domains x 3 levels x 12 questions is roughly US$60-75 one-time. The pool's daily cap (`REASONING_POOL_DAILY_CAP_USD`, default 5) paces this over about two weeks; learners starting a domain whose bucket is empty still get a question on demand, billed to their own daily cap since 23 Oct 2026. Raise the cap for a faster initial fill. Since 23 Oct 2026 only buckets in demand are filled to 12; the others stop at the idle target (2).

### Known limits and next steps

- Generation takes about 30-90 s with the real model; the UI says so and the attempt survives a page reload. A streamed "scenario preview" is not implemented.
- Validator rejections cost a generation call each (about US$0.075 settled), and refused or truncated calls are billed too. Watch `ReasoningGenerationRejected` and the logged reasons; if one rule dominates, either teach the prompt or add a repair to the normalisation pass.
- The similarity check is lexical (word trigrams). It catches rephrasings of the same item; semantic near-duplicates with different vocabulary rely on the seed rotation.
- Pool questions are shared, so a cohort can still recognise a question by its text and pass answers around; the public view no longer carries a machine key, unanswered questions expire after a day, and answer time is shown. Larger or per-learner buckets, a time box per question and flagging widely shared items are product decisions (see below).
- The dispute button (ADD L17b) and the human-graded replay set are not built; `stages` holds what they need.
- Review-flagged results are visible to the learner with the flag; there is no reviewer queue yet.

### Budgets, limits and costs (23 Oct 2026)

Changes from the 23 Oct 2026 security audit (TR-08, TR-10, TR-21, TR-42, TR-59 and the regressions AR-REG1..5). This section is the current operating reference.

**Budget policies** (`LlmService`, `modules/ai/llm.service.ts`):

| Work | Policy | Limits that apply |
|---|---|---|
| Evaluation stage 1 (evaluator) | `reasoning` | learner's `AI_USER_DAILY_CAP_USD` (shared with interviews) and the global breaker at 100% |
| Evaluation stages 2-3 (challenger, reconciler) | `finalize` | the global breaker with 10% grace, so an evaluation that started can finish |
| On-demand generation (learner has seen the whole bucket) | `reasoning` with `keepFreeUsd` | learner's daily cap minus the room one stage-1 evaluation needs, and the breaker: generating questions can never lock a learner out of having an answer they wrote evaluated |
| Pool generation | `pool` | `REASONING_POOL_DAILY_CAP_USD` on the platform account and the breaker |

**Checks before the learner commits** (`ReasoningService`): `POST /attempts` hands out a pool question only when its evaluation fits the learner's budget and the breaker is closed, and starts an on-demand generation only when the generation plus the evaluation room fit; `POST /attempts/{id}/submit` and `/retry` check the daily quota and the budget before the attempt changes state. Refusals are 429 `LLM_BUDGET_EXCEEDED` (learner's day), 503 `AI_SERVICE_PAUSED` (breaker) or 429 `REASONING_DAILY_LIMIT_REACHED` (quota), each with `details.resetAt` (00:00 UTC) and a Retry-After header; the attempt stays as it was and the AR client keeps the draft in the tab and says when the limits reset in the learner's local time. These checks do not reserve; the call reserves again when it runs, so a race between two of one learner's requests can still fail an evaluation in flight (then retrying is free).

**Per-learner limits** (all accept `0` = no limit):

| Setting | Default | What it bounds |
|---|---|---|
| `REASONING_USER_DAILY_EVALUATIONS` | 20 | answers submitted for evaluation per UTC day (a retry of today's answer is not counted twice). Concurrent submissions are serialised per learner (advisory lock), so the quota holds under concurrency. |
| `REASONING_USER_DAILY_REFILLS` | 60 | background refills one learner may trigger in a rolling 24 h (in-memory counter); a request when the bucket is already at its target is not counted |
| `REASONING_MAX_RETRIES` | 2 | manual retries per attempt of a failed generation, and separately of a failed evaluation (409 `REASONING_RETRY_LIMIT_REACHED` beyond it; a retry after a budget refusal is not counted). Columns `generation_retries`, `evaluation_retries` (migration 0013). |
| `REASONING_READY_TTL_HOURS` | 24 | an unanswered question is skipped by the sweeper after this long (the attempt view's `expiresAt` says when; 0 = never). After a submission the daily evaluation quota or an AI budget refused, not before this long after the next 00:00 UTC: the first refusal is recorded in `submit_refused_at` (migration 0015, once per attempt) and the refusal's `details.expiresAt` gives the new time |
| `REASONING_MAX_OPEN_ATTEMPTS` | 3 | unanswered or evaluating questions at once (starting another skips the oldest unanswered one, after the learner confirms when that skip counts as 0) |

**The question pool** (`GenerationService.needed`, `JobsService.fanOutRefill`):

- `REASONING_POOL_ENABLED` defaults to on in production and off everywhere else. Off removes the persisted `*/15` schedule at the next worker start (`QueuePort.unschedule`; pg-boss keeps schedules in its tables, so before this, switching the flag off did not stop it) and every refill, including jobs the old schedule queued, is a no-op.
- Demand-driven targets: a bucket served in the last `REASONING_POOL_DEMAND_DAYS` (7) is kept at `REASONING_POOL_TARGET` (12); any other at `REASONING_POOL_IDLE_TARGET` (2). The schedule queues jobs only for buckets short of their target, so an idle platform generates nothing once the idle targets are met.
- Top-ups for active learners: when a learner served from a bucket in the demand window has fewer than `REASONING_POOL_MIN_AVAILABLE` (4) questions left unseen, the schedule grows that bucket past the target, up to `REASONING_POOL_MAX_ITEMS` (40), on the pool budget. A learner's own visit never grows a bucket past the target; until the next scheduled run they get questions on demand (billed to them). The prefetch status reports `refilling: true` only when more questions will really appear without starting one (the pool's daily budget can still pay for a generation today, and a refill was queued or the schedule will grow the bucket), and the client then polls with back-off (5 s doubling to 60 s, for at most 10 minutes); otherwise, and once that window has passed with nothing new, it says the next question is generated when the learner starts.
- Similarity: an on-demand question is compared with the bucket's latest 80, the domain's latest 40 at other levels, and every question the learner has had in the domain at any level (text similarity; a variation fingerprint shared across levels is not a repeat).
- Switch it off: set `REASONING_POOL_ENABLED=false` and restart the worker (the schedule is removed on start). To stop spending without a restart, set `REASONING_POOL_DAILY_CAP_USD` to a tiny value such as `0.01` (it must be positive).

**Shared pool and answer keys** (TR-42, code side): the public view carries the attempt's id instead of the shared question's id and only the day the question was generated; answer time (wall clock from the question being shown to the submission, information only, never scored) is stored implicitly by `opened_at` and `submitted_at` and shown on the result; unanswered questions expire after `REASONING_READY_TTL_HOURS`. The correct answer is still shown after evaluation, which is the product's teaching model.

**Skips** (BIZ-09): a question that was shown and then skipped, expired or displaced by a newer start is recorded as skipped and counts as answered with 0: in `attempts` and `skipped`, as 0 in `averageScore` and as not correct in `correctRate`, on the dashboard, per domain, in the onboard summary (new "Skipped" stat) and in the session summary. A skip before the question was shown (while it was still being generated, or after generation failed) does not count. The rule is not retroactive: `reasoning_attempts.skip_counts` (migration 0014) is false for every attempt that existed before it, whose learner was told a skip would not count, so those skips (and the first sweep's expiry of old unanswered questions) leave averages unchanged; new attempts default to true. The attempt view carries `skipCounts` and `expiresAt`, and history rows carry `countsAsZero`. No question turns into a 0 unasked: Skip, End assessment and the domain page's "Start a new one instead" confirm first; a start that would displace the oldest unanswered question at the open-question cap needs the learner's confirmation (above); and a ready question says when it is skipped automatically and that it then counts as 0.

**Prompt injection** (TR-21): earlier stages' outputs reach the challenger and reconciler as JSON with every `<` escaped (`\u003c`), so learner text quoted in them cannot close or open a block; tag-like text in the justification is defused; the later stages are told those blocks are untrusted data. An integrity flag (off-topic, instructs the grader) raised by any stage stands: a later stage can add one but not clear it. Prompt version `reasoning-evaluate.v2`.

**Costs** (Sonnet 5.5, measured in the audit of 23 Oct 2026):

| Item | Cost |
|---|---|
| One settled generation call | about US$0.075 (reservation while in flight about US$0.165) |
| One stored question, including rejected and refused tries (about 20% refusals, billed) | about US$0.104 |
| One evaluation (three stages) | about US$0.082 (stage 1 alone about US$0.04-0.05 reserved) |
| A learner's day at the defaults | at most `AI_USER_DAILY_CAP_USD` (2), shared with interviews; 20 evaluations at most |
| Pool, idle production | idle targets: 15 domains x 3 levels x 2 = 90 questions once (about US$9, paced by the US$5/day cap), then nothing until learners create demand |
| Pool, active buckets | up to 12 per bucket in demand, and top-ups to at most 40 per bucket for learners who run out, always within `REASONING_POOL_DAILY_CAP_USD` per day |

**Gateway** (`attack-reasoning/server`): per-IP buckets apply only to traffic without a session this process recognises (a signed-in learner pays at most once per identity cache period); requests without a plausible `tr.session_token` cookie (`<token>.<44-character base64 signature ending in "=">`, the same check as the labs hub, InterviewPrep and Red Team resolvers) never reach onboard, and the identity cache is keyed on the session token alone; at most `AR_IDENTITY_MAX_PER_CLIENT` (16) lookups per client run at once and more from that client wait up to 5 s for one of its slots (a bounded queue, then a 429 with Retry-After), so junk cannot fill the global slots while a classroom behind one NAT is served in waves; a session onboard confirmed in the last 12 hours is never shed by either cap; the client IP is read from `x-threatready-client-ip` only behind the ThreatReady gateway or a proxy declared with `AR_TRUST_CLIENT_IP_HEADER=1`; the `/v1` proxy forwards a body only for methods that carry one, with explicit framing, and counts it: past 256 KiB (declared or chunked) it answers 413 `PAYLOAD_TOO_LARGE` and drops the upstream request; the standalone server sends CSP (`connect-src 'self'`, `frame-ancestors 'none'`), nosniff, X-Frame-Options and Referrer-Policy, and serves `/v1` with its path intact. Its own 429s on `/v1` use the engine's error envelope.

**Tests**: `apps/api/test/reasoning.e2e.test.ts` (30, PostgreSQL + fake model) adds the budget gates on both start paths and on submit, the breaker, the concurrent quota and `0` = no limit, retry ceilings, integrity across stages and escaped prompts, answer time and expiry, skips in every statistic, the skip rule not applying to attempts from before it, the confirmation before a counted displacement, `refilling` false once the pool budget is spent, the learner-history similarity bank, the pool switch-off with a persisted schedule, demand targets and top-ups; `apps/api/test/reasoning.unit.test.ts` (7) covers the configuration defaults and the prompt structure; `attack-reasoning/tests/hardening.test.ts` covers the identity pre-filter, the queued per-client cap and the known-good bypass, 40 cold sessions behind one NAT signing in at once, per-learner limits behind one NAT, the client-IP trust rule, the `/v1` 429 envelope, request framing and the body cap, the standalone headers, the UUID fallback, the client's messages and its confirmation before a counted displacement.
