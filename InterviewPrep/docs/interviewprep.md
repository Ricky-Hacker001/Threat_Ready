# InterviewPrep — design and operations

InterviewPrep is the resume-and-JD-driven mock interview vertical of ThreatReady. It follows the
Architecture Decision Document of 9 Oct 2026 (ADD): one NestJS modular monolith with `api` and
`worker` roles from one image, a static Vite React SPA, PostgreSQL (RDS) as the only database,
pg-boss for jobs, S3 for files, Better Auth in-process, and Anthropic reached only through
`LlmPort`. It adds no new service, database, cache, queue or LLM provider.

## 1. Repository and architecture mapping

There was no existing platform repository to integrate with (`InterviewPrep/` was empty; the only
code nearby is `threatready-lab-001`, a standalone Express prototype). This repository is therefore
laid out exactly as ADD §6 prescribes, containing the InterviewPrep vertical plus the minimum of
each platform module it depends on, so it can be merged into the platform repository module by
module:

| ADD §6 path | Here | Notes |
|---|---|---|
| `apps/api` | NestJS 12 (ESM), roles `api`, `worker`, `migrate` | Better Auth is ESM-only, so the API builds as ESM (the ADD's week-one coupling item) |
| `apps/web` | Vite 8 + React 19 SPA | Static; the 3D stack is a lazy chunk loaded only in the interview room |
| `packages/contracts` | Zod schemas → OpenAPI 3.1 (`openapi.json`) | Also the route table: permission and rate class per route |
| `packages/db` | Drizzle 0.45 schema, SQL migrations, RLS policies | Policies are declared in the schema (`pgPolicy`) |
| `packages/shared` | Error catalogue, ids, log scrubbing | ADD §10 codes |
| `content/interview` | Skills, role frameworks, rubrics, tracks, question templates | Versioned rows mirrored into `skills` and `rubrics` at boot |

Backend modules (ADD §6 names): `platform/auth` (Better Auth adapter), `platform/authz` (principal,
role→permission map, guard), `documents`, `interview`, `ai` (LlmService: tiers, prompt registry,
budgets, `llm_call_log`), `scoring`, `skills`, `reports`, `jobs`. Domain modules import ports only;
an ESLint rule forbids vendor SDK imports under `apps/api/src/modules`.

Platform pieces here are deliberately minimal stand-ins where the real platform owns them:
billing/entitlements are a monthly quota from configuration; organisations are personal orgs
created on sign-up; the sign-in screen is a development screen.

### Deliberate differences from the ADD (and why)

| ADD | Here | Reason |
|---|---|---|
| SMALL = `claude-haiku-5-5` at US$0.10/0.50 | SMALL = `claude-haiku-4-5` (US$1/5), configurable | `claude-haiku-5-5` is not in Anthropic's verified model table (2026-09-25). Config refuses unverified ids unless explicitly priced via `LLM_PRICING_OVERRIDES` |
| States `created → parsing → planned …` | `parsing → profiled → planned …` | The product requires the candidate to confirm extracted details and configure before planning. Documents exist before the session, so `created` is unused |
| Gap analysis then plan in one worker job | Gap analysis in the analysis job; plan built in code at confirmation | Config (type, difficulty, duration, focus) is chosen after the briefing; the plan is pure code, so it runs synchronously |
| StoragePort `putUrl/getUrl/move/delete` | adds `head/read/put` | The worker must read uploads and write PDFs (ADD LLD-4/LLD-6 do both) |
| `INTERVIEW_TURNS` without `user_id` | `user_id` on every owned table | Uniform RLS owner policy |
| RESUMES/JOB_DESCRIPTIONS `extracted_text` | stores the **redacted** text | Contact details are never needed by the product |

## 2. End-to-end flow

```
Browser ──presigned POST──▶ S3 quarantine/
   │ POST /v1/documents/{id}/complete ─▶ job document.extract (worker)
   │                                       magic bytes · worker-thread extraction (20 s, 256 MB)
   │                                       normalise · redact · move to documents/
   │ POST /v1/interviews ─▶ session `parsing` + job interview.analyse (same transaction)
   │                          SMALL: resume→candidate_profile, JD→job_profile (cached by text hash)
   │                          LARGE: gap analysis; every claim quote verified against the resume
   │ GET  /briefing  (state `profiled`) → candidate confirms/corrects, configures
   │ POST /plan      → plan built in code → `planned`
   │ POST /start     → SSE: question streamed (SMALL) → `awaiting_answer`
   │ POST /turns     → SSE: `evaluating` → SMALL provisional evaluation (quote-checked)
   │                       → follow-up decision in code → next question streamed
   │ … until plan end, 18 turns, time up, budget cap, or candidate ends
   └ `scoring` + job interview.final_scoring (same transaction)
         LARGE: levels + quotes per criterion per turn → quote check → scores in code
         → evaluation + skill_evidence + report (one transaction, idempotent)
         → jobs skills.recalculate, interview.report_pdf, email.send
```

Live turns stay synchronous on the API (ADD L13); expensive scoring and PDFs run on the worker.
The browser learns about job progress through `GET /v1/interviews/{id}/events` (SSE), with polling
as a fallback.

### Session state machine

| State | Leaves on | Timeout / recovery |
|---|---|---|
| `parsing` | profiles + gap analysis stored → `profiled`; two failed attempts → `failed` | sweeper fails it after 20 min |
| `profiled` | candidate confirms → `planned`; cancel → `cancelled` | 7 days → `expired` |
| `planned` | start → `asking` | 7 days → `expired` |
| `asking` | question stored → `awaiting_answer` | 45 s lease; `POST /question` regenerates after it lapses |
| `awaiting_answer` | answer → `evaluating`; pause → `paused` | 10 min idle → `paused` |
| `evaluating` | decision → `asking`, or `scoring` | 20 s evaluation timeout → continue without follow-up |
| `paused` | resume → `awaiting_answer` | 24 h → `scoring` (or `expired` with no answers) |
| `scoring` | report stored → `report_ready`; dead-lettered → `failed` (retryable) | 5 retries 30 s → 30 min |

The interview clock runs only in `awaiting_answer`; model latency and pauses never use the
candidate's time.

## 3. LLM use (through `LlmPort` only)

| Step | Tier | Budget policy | Output |
|---|---|---|---|
| Resume → candidate profile | SMALL | new_interview | schema-validated JSON; skill ids are an enum of the catalogue |
| JD → job profile | SMALL | new_interview | role id and skill ids are enums |
| Gap analysis | LARGE (effort low) | new_interview | claims (quote-verified) and gaps |
| Question wording | SMALL, streamed | live_turn | plain text, ≤ 700 chars; template fallback on any failure |
| Per-turn evaluation | SMALL, 20 s | live_turn | criterion levels 0–4 with quotes; drives follow-ups only |
| Final scoring | LARGE (effort medium) | finalize | answers assessed in parallel batches of 4 (levels + quotes, feedback, strong-answer examples), then one short call writes the summary and improvement plan, so no response grows with interview length |

* The application asks for tiers; `LLM_MODEL_SMALL/LARGE` map them to verified ids. Optional boot
  verification calls the Models API (`LLM_VERIFY_MODELS_ON_BOOT=true`).
* Every call is reserved in `llm_call_log` before it runs (estimated cost) and settled after with
  provider-reported tokens, latency and cost; failures are marked. Cost per session is
  `SUM(cost_usd) WHERE source_id = <session>`.
* Tier-3 budgets (ADD L12): per-session cap minus a reserve for final scoring, per-user-day cap,
  global daily breaker (new interviews pause, live ones finish), 100K-token prompt ceiling.
* Errors: the SDK retries 408/409/429/5xx with backoff (`LLM_MAX_RETRIES`); one extra retry on a
  schema failure; `refusal` stops raise a typed error, with an optional configured fallback model
  for LARGE calls; `max_tokens` truncation is treated as invalid output.
* Context discipline (ADD L14): raw resume/JD text crosses to the model once per document
  version; later prompts carry profiles, the plan item, the last four turns and an
  application-held running summary. No RAG, no vectors, no provider-side threads.

### Prompt-injection controls

Documents and answers are untrusted: they are passed inside `<untrusted_*>` delimiters that the
content cannot close, the system prompt states that instructions inside them are data, outputs are
constrained to JSON schemas with enum ids, every level needs a verbatim quote from the answer (or
drops to 0), and `answer_integrity.instructs_grader` is surfaced in the report. The model never
produces a number that reaches the report.

## 4. Scoring (deterministic, `scoring.ts`, version `score.v1.2026-10-12`)

* Level 0–4 → 0/25/50/75/100 points. A level counts only with a verbatim quote from that answer.
* Question score = rubric-weighted mean of applicable criteria (`content/interview/rubrics.json`):
  technical 0.35/0.20/0.20/0.15/0.10 (correctness/completeness/reasoning/communication/evidence);
  behavioural has no technical-correctness weight; the closing question is unscored except for
  communication.
* Follow-up turns weigh 0.5 when aggregating.
* Categories: technical knowledge (correctness), problem solving (reasoning, scenario/design/coding
  ×2), communication, role skill coverage (JD skills weighted must 3 / should 2 / nice 1; untested
  = 0).
* Overall = 0.35 technical + 0.25 problem solving + 0.15 communication + 0.25 coverage,
  renormalised over the categories that apply.
* The report states that it is a simulated assessment, not a prediction of hiring success.

## 5. Data model (migrations in `packages/db/migrations`)

`0000_roles` creates `tr_app_user` (NOLOGIN, NOBYPASSRLS). `0001_interview_prep` creates the Better
Auth tables, `organisations`, `memberships`, `resumes`, `job_descriptions`, `candidate_profiles`,
`job_profiles`, `interview_sessions`, `interview_turns`, `evaluations`, `reports`, `skills`,
`rubrics`, `skill_evidence`, `skill_scores` and `llm_call_log`, with RLS enabled and an owner
policy on every owned table. `0002_grants` grants the RLS role and adds the
`ai_spend_today_usd()` SECURITY DEFINER function for the global breaker.

Idempotency is enforced by constraints: `interview_turns (session_id, seq)` and
`(session_id, client_submission_id)`, `evaluations (session_id, scoring_version)`,
`reports (evaluation_id)`, `skill_evidence (source, source_id, skill_id, scoring_version)`,
profiles `(document, text_hash, parser_version)`; jobs are sent with ids derived from their
idempotency keys.

**RLS in production:** the API's login role (`tr_api`) is a member of `tr_app_user`, has no
BYPASSRLS and owns nothing; every user-scoped transaction runs `SET LOCAL ROLE tr_app_user` and
`set_config('app.user_id', …, true)`. The worker's role owns the tables. pg-boss statements in a
user transaction step out of the RLS role for the queue's own tables only, so an enqueue commits
or rolls back with its state change. Grant `tr_api` usage on schema `pgboss` and on the auth tables.

`0016_security_patch_2` narrows `tr_app_user` on `reasoning_items` to a column-level SELECT that
leaves out `private` (the answer key, read only through the owner role after ownership is checked)
and no INSERT/UPDATE/DELETE; a SECURITY DEFINER trigger on `reasoning_served` keeps `serve_count`.
A later column on `reasoning_items` needs its own grant. It also adds
`interview_sessions.evaluating_lease_until`, after which a lost answer evaluation is recovered.

## 6. API

24 routes, generated into `packages/contracts/openapi.json` (`npm run openapi`). Each route
declares a permission and a rate class; the API refuses at boot if a contract route has no
handler, and the guard refuses any handler without a declared permission.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/documents` | create document + presigned POST into quarantine |
| POST | `/v1/documents/text` | pasted JD |
| POST | `/v1/documents/{id}/complete` | confirm upload, queue extraction |
| GET / PATCH / DELETE | `/v1/documents/{id}`, `/v1/documents/{id}/text` | status + redacted text, corrections, delete |
| POST / GET | `/v1/interviews` | create session (queues analysis) / history |
| GET | `/v1/interviews/{id}` | full session view: state, progress, timer, current question, transcript |
| GET | `/v1/interviews/{id}/events` | SSE state changes |
| GET | `/v1/interviews/{id}/briefing` | extracted profiles + recommendation |
| POST | `/v1/interviews/{id}/plan` | confirm, correct, configure → plan |
| POST | `/v1/interviews/{id}/start`, `/question`, `/turns` | SSE turn streams |
| POST | `/v1/interviews/{id}/pause`, `/resume`, `/end`, `/cancel` | session control |
| GET / POST / GET | `/v1/interviews/{id}/report`, `/report/retry`, `/report/pdf` | report, retry, 120 s signed URL |
| GET | `/v1/interview-prep/dashboard`, `/v1/skills/me` | aggregates from stored data |

Turn stream events: `evaluating`, `feedback` (practice mode only), `question.start`,
`question.delta`, `question.reset`, then exactly one `done` (full session view) or `error`.
Errors before the stream starts return a normal HTTP status with the ADD §10 envelope.

## 7. Security summary

Authentication on every route (Better Auth cookie: httpOnly, SameSite=Lax, Secure in production)
plus an Origin check on state-changing requests; role→permission map; ownership via scoped
queries returning 404; RLS backstop; tier-2 token buckets (uploads 10/h, turns 40/min, creates
10/h, general 600/min); presigned uploads with size/type conditions into a quarantine prefix,
opaque keys, magic-byte checks, sandboxed extraction, private bucket, 60–300 s download URLs,
files deleted 30 days after parsing; no document text, answers, prompts or model output in logs
(pino redaction) or Sentry (`beforeSend` scrubbing); rubrics and evaluation internals never reach
the browser in realistic mode.

## 8. Cost

`apps/api/scripts/estimate-cost.ts` runs complete simulated interviews through the real API and
prompt builders and measures every prompt the code sends; output tokens are stated assumptions;
prices come from the verified registry. Results (Haiku 4.5 SMALL, Sonnet 5.5 LARGE, a 5,000-
character resume, 150–250-word answers, no prompt caching because the stable prefixes are below
Haiku 4.5's cache minimum) are written to `docs/interviewprep-cost-estimate.json`:

| Duration | Turns | Estimated LLM cost |
|---|---|---|
| 15 min | 6 | ≈ US$0.13 |
| 30 min | 12 | ≈ US$0.20 |
| 45 min | 17 | ≈ US$0.26 |

Final scoring on the LARGE tier is about half of the total. The ADD's Attack Reasoning figure does
not apply. At the ADD's S1 volume (2,000 interviews a month), a 30-minute average is roughly
US$400 a month. Replace these estimates with measured averages from `llm_call_log` after the first
week of real traffic (queries in the script header). Levers: Anthropic's Batch API for final
scoring (half price, delayed report), effort `low` for final scoring if the replay set agrees,
and prompt caching once a stable prefix exceeds the cache minimum.

## 9. Configuration

See `.env.example`. In AWS, ECS injects values from SSM Parameter Store (SecureString) and
Secrets Manager (`DATABASE_URL`). Production refuses `STORAGE_DRIVER=fs`, `LLM_DRIVER=fake` and a
missing `SENTRY_DSN`.

## 10. Running locally

```bash
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env            # LLM_DRIVER=fake works offline; set ANTHROPIC_API_KEY + anthropic for real calls
npm run build -w @threatready/shared -w @threatready/contracts -w @threatready/db
set -a; . ./.env; set +a
npm run db:migrate
npm run dev:api                 # http://localhost:3000
npm run dev:worker
npm run dev:web                 # http://localhost:5173 (proxies /v1 and /api/auth)
```

Tests need PostgreSQL at `DATABASE_URL` (the test suite creates and drops `threatready_test`):
`npm test`. All model calls in tests go through the fake `LlmPort`; no paid calls.

## 11. Voice and interview interactions

Voice runs entirely on browser APIs; the interview engine, prompts and storage are unchanged
because a turn is still "question text out, answer text in":

* **Alex speaks** with speech synthesis (most natural available voice, queued by sentence because
  Chrome cuts off long utterances). With a model that has visemes (Rocketbox), each spoken word is
  mapped to them for lip sync; the default scanned model opens its jaw with speech instead.
* **The candidate speaks** through speech recognition (Chrome, Edge, Safari). Text streams into the
  editable answer box; a pause offers auto-submit with a visible countdown that speaking cancels.
  The candidate picks their accent (English India/US/UK/…; defaulted from the browser and time
  zone), which matters most for accuracy. The browser's speech service transcribes by default
  (disclosed on the configure screen); on-device recognition is an opt-in in Voice settings, where
  it also receives security vocabulary as phrase hints if the browser supports biasing. Words still
  being transcribed are kept when Chrome restarts its session and when the answer is submitted, and
  a conservative clean-up fixes spelled-out acronyms and misheard jargon (`lib/transcript.ts`, e.g.
  "s i e m" → SIEM, "mitre attack" → MITRE ATT&CK). Typing is always available.
* **Repeat**, **interrupt** and **ask a clarifying question** (`POST /v1/interviews/{id}/clarify`,
  up to three per question, stored on the turn, answers never given away), as in a real interview.
* Very short answers get a gentle nudge before submission; "I don't know" gets a kind response and
  a more approachable next question, never a follow-up.
* **Follow-ups pick up what the candidate said** (decided in code, `adaptive.ts`): thin answers are
  clarified, solid ones probed for specifics ("You said you'd isolate the host first. How would you
  decide…"), strong ones deepened, and the introduction gets one follow-up on a project or role the
  candidate mentioned. The session's follow-up budget is spread across the plan, not spent early.

V2 can replace browser speech with server-side speech-to-text and text-to-speech (and a WebSocket or
WebRTC transport, ADD L14) behind the same turn loop; the avatar already takes a `speechLevel` signal.

## 12. Known limitations

* Browser voice quality and recognition accuracy depend on the browser and OS voices; Firefox has
  no speech recognition, so voice answers fall back to typing there.
* The 3D interviewer is Renderpeople's free scanned character "Eric Rigged 001" (Extended Use
  Licence), converted by `apps/web/scripts/build-avatar-renderpeople.ts`. The licence forbids making
  the model easily downloadable, so it is served only to signed-in users, encrypted per response
  (`GET /v1/assets/interviewer-model`); see
  `apps/web/src/features/interview-prep/avatar/ASSET_LICENSE.md`. It has no visemes: the mouth opens
  with speech but is not phoneme-accurate (the MIT Rocketbox alternative has visemes).
* Cost figures are estimates from measured prompt sizes and assumed output sizes; no real API calls
  were made during development.
* Billing, organisations, institute roles and the production sign-in UI are minimal stand-ins for
  the platform's modules.
* The in-memory rate limiter is per task (ADD L11/L12: counters move to Valkey at the trigger).
* Grader agreement has not been measured; the ADD's replay set of human-graded transcripts should
  gate prompt, rubric and model changes before launch.
