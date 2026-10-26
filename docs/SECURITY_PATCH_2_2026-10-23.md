# ThreatReady security patch 2 — 23–26 Oct 2026

Builds on `SECURITY_PATCH_2026-10-23.md` (Patch 1). Code-level hardening only — no product, concept or UX
changes. Every lab, interview and reasoning attempt behaves as before for the learner. The one place
dependency versions changed (A14) regenerated its lockfiles; `npm ci` / `pnpm install --frozen-lockfile` and
`deploy/build.sh` work as before (now on Node 24, which `engines` enforces to match `render.yaml`).

## Deploy notes (read before deploying)

1. **Three children now.** The Labs hub and every hosted lab (SOC, Red Team, DevSecOps, ThreatWall, AI-Security)
   plus Attack Reasoning run in `deploy/labs-child.mjs` on loopback `:4000` (`LABS_INTERNAL_PORT`), supervised
   like the two APIs. A lab bug can no longer take down sign-in. Heaps: gateway 48 MB, onboard 110, InterviewPrep
   180, labs 150 (sum 488 against ~400 MB resident). `/readyz` reports all three with `exits` and `heapUsed`.
2. **Required new env var:** `LLM_MODEL_SMALL` (declared in `render.yaml`, value `claude-haiku-4-5` = the previous
   default). InterviewPrep refuses to boot in production without it — deliberate: the SMALL model id and the
   budgets derived from it are now explicit, never silently defaulted.
3. **Migrations run on boot:** onboard `0006_rls_backstop_shared_tables.sql`; InterviewPrep
   `0011_security_patch_2.sql` (lease column, indexes, `serve_count` + trigger, column-level grants on
   `reasoning_items`). The launcher also creates `threatready_launcher_state` (owner-only).
4. **Internal tokens are per caller.** The launcher derives one HKDF token per (caller → callee) from
   `INTERNAL_API_TOKEN`; in production no child receives the raw token in its environment and
   `INTERNAL_TOKEN_LEGACY_ACCEPT` is false. Nothing to configure. Local dev without the launcher still works with
   `INTERNAL_API_TOKEN` alone. *Merge review M-SEC-2:* this limits what a child is given, not what it can read.
   All processes run as one user, so code execution in any child can read the launcher's and the other
   children's start-up environment from `/proc/<pid>/environ` (raw token, `BETTER_AUTH_SECRET`, owner database
   URLs, API keys). Treat the per-caller tokens as defence in depth; `deploy/README.md` ("Limits of the
   isolation") lists the owner's options (separate user, non-dumpable launcher, labs on their own service).
5. **Optional new tunables:** `REASONING_ITEM_MAX_SERVES` (25), `FORCE_ROLE_SYNC`, `INTERNAL_TOKEN_LEGACY_ACCEPT`,
   `LABS_INTERNAL_PORT`. `AI_*_CAP_USD` are now optional (derived from pricing; current models yield the old
   0.6 / 0.2 / 2 / 60 exactly).
6. **Node ≥ 24 everywhere** (`engines`, `soc/.node-version`, CI). pnpm refuses to install onboard on older Node.
7. **CI:** `/.github/workflows/ci.yml` now gates typecheck, lint (incl. the regex scanner), unit tests, `npm audit
   --omit=dev --audit-level=high`, gitleaks and a full `deploy/build.sh`. Set Render "Wait for CI" (owner decision;
   `autoDeploy` left as is). Actions are still pinned by tag — pin SHAs when GitHub is reachable.

## Fixed (Part A)

| # | Item | Fix | Verified |
|---|---|---|---|
| A1 | InterviewPrep DB resilience (HIGH) | `pool.on('error')`, 5 s connection / 30 s idle timeouts; `uncaughtException`/`unhandledRejection` → log, flush Sentry, `exit(1)` once | unit |
| A2 | Sessions stuck in `evaluating` | `evaluating_lease_until` (120 s); sweeper recovers expired leases as a failed evaluation and moves on; each sweep step in its own transaction | e2e |
| A3 | Indexes + migration hygiene | `evaluations(user_id)` and pool serve indexes; onboard snapshots 0002–0005 regenerated — surfaced 5 CHECK constraints and PK/FK names missing from `schema.ts`, fixed; `pnpm db:generate` emits nothing | e2e, generate |
| A4 | DOCX zip bomb | Central directory parsed before inflation: total > 50 MB, any entry ratio > 100:1 (entries > 1 KB), > 2000 entries → `RESUME_TOO_LARGE`; worker heap 256 → 96 MB; one extraction at a time | unit (forged 1 KB→200 MB entry never inflated) |
| A5 | Pool answer keys | Column-level grant hides `reasoning_items.private` from `tr_app_user` (also no INSERT/UPDATE/DELETE); `result()` reads it as the owner role only after ownership is confirmed; items retire after `REASONING_ITEM_MAX_SERVES` | e2e as `tr_app_user`: `SELECT private` → 42501 |
| A6 | SMALL model cost model | `LLM_MODEL_SMALL` required in production; caps derived from the pricing table; model id validated with `Object.hasOwn` (found by fuzz: `constructor` passed before) | unit |
| A7 | Lab store hygiene | GET never writes (`upsertUser` moved to the first state change); corrupt JSON stores renamed `.corrupt-<ts>` instead of overwritten | tests (mtime/sha unchanged) |
| A8 | Launcher correctness | `INTERVIEW_APP_URL` → `/interview-prep/`; `ALTER ROLE` skipped when the password digest is unchanged; RLS backstop on `users`/`memberships`/`organizations` (request-scoped policies, since Better Auth and admin read across users) | launcher tests, e2e 22/22 |
| A9 | Per-caller internal tokens | HKDF(`caller->callee`) tokens; every callee compares against its accept list in constant time, raw token only with legacy accept; launcher never hands the raw token to a child in production. *Merge (M-SEC-1):* InterviewPrep's account erasure, summary and AI-usage routes accept onboard's token alone (`INTERNAL_TOKEN_FROM_ONBOARD`, required in production); Attack Reasoning's token, held by the labs child, opens only `/internal/v1/reasoning/*`. *Limit (M-SEC-2):* same user for every process, so a compromised child can still read other processes' environments (deploy note 4) | unit/e2e in all 5 apps |
| A10 | Lab process isolation (HIGH) | `deploy/labs-child.mjs`; gateway proxies `/labs`/`/ar`; security-headers middleware exported and applied in the child so per-path CSP (DevSecOps sandbox, Red Team frame) still works; `trust proxy loopback` + gateway IP → X-Forwarded-For so `req.ip` is the visitor. *Limit (M-SEC-2):* contains crashes and memory, not secrets: code execution in the labs child can read the launcher's environment from `/proc/<pid>/environ` (deploy note 4) | full launcher boot + labs-child tests |
| A11 | Security test harness | Gateway contract suite (edge headers, IP stamping, headers on every mount, hop-by-hop, SSE, no `.map`); dependency-free `tools/check-regexp-from-input.mjs` + allowlist (10 findings, all justified); `protoKeys` fuzz helpers in all apps; second-user IDOR generators for labs/Red Team/SOC; 47-case LLM injection corpus; regex timing tests (found + fixed a quadratic email-redaction regex: 1.6 s → 0.5 ms per document) | all green |
| A12 | CI gate | Matrix over every lockfile + gitleaks + Render build job; Node 24; `permissions: contents: read` | yml |
| A13 | Observability | Gateway mints `x-request-id` on every request (client value never kept — the APIs trust a well-formed id); echoed in every error envelope across all apps; structured `child_exit` JSON; `heapUsed` per child in `/readyz`; onboard `GET /__health` (loopback). Onboard Sentry skipped (not in its lockfile) | gateway tests |
| A14 | Dependencies | See table below; zero high/critical runtime advisories in every lockfile afterwards. *Merge review M-SEC-3:* no longer true as of 2026-10-22 (body-parser GHSA-27r3-jxmh-p828, multer GHSA-q7qp-rjg7-q26m; main affected equally), so the CI audit gate fails until the owner decides `SECURITY_PATCH_2026-10-24.md` decision 13 (lockfile-only fixes prepared) | `npm audit`, tests, builds, PDF byte-identical |
| A15 | Patch-1 leftovers + lab functionality | SOC client URLs relative to `BASE_URL` (live console/downloads work under `/labs/soc/`); Red Team target served as `/target-frame.html` with a sandboxed CSP (opaque origin) — recon/XSS/SQLi/JWT/IDOR exercises verified in headless Chromium behind the gateway CSP (132/132 engagement); ThreatWall legacy FNV hashes re-hashed on login, legacy keys migrated at boot; `_headers` generated from the gateway CSP with a CI drift check; meta CSP on the 7 landing pages; `.gitignore` alignment | builds + Chromium |

### A14 dependency changes

| Package | Dependency | Before → After | Cleared |
|---|---|---|---|
| AI-Security | express | 4.21.2 → 4.22.3 | path-to-regexp high, qs, body-parser |
| AI-Security | jspdf | 2.5.2 → 4.2.1 | 12 jspdf advisories (2 critical) + transitive dompurify (19); PDF output byte-identical in size and page count |
| AI-Security | vitest / vite / @vitejs/plugin-react (dev) | 2.1.8 → 5.0.5 / 5.4.11 → 8.3.4 / 4.3.4 → 6.1.2 | vitest/tinypool critical RCE-when-listening, vite dev-server |
| ThreatWall | vitest (dev) | 3.2.7 → 5.0.5 | tinypool critical |
| threatready-lab-001 | vite-plugin-singlefile (dev) | removed (unused) | braces high |
| all | `engines.node` | → `>=24` | — |

SOC stays on Express 4.22.3 (patched) mounted behind the Express 5 gateway. Remaining dev-only advisory:
AI-Security `playwright` < 1.55.1 — bump in a follow-up.

## Verified

- Per app (fresh `npm ci`, Node 24): threatready-lab-001 65/65, attack-reasoning 27/27, red_team_lab 33/33,
  soc 108/108, ThreatWall 51/51 + Playwright 30/30, AI-Security 199/199, DevSecOps build, InterviewPrep api
  unit 129/129 + reasoning/security e2e against PostgreSQL 16 (33 pre-existing failures byte-identical to
  baseline, zero new), onboard typecheck + routes 14/14 + e2e 22/22 on PostgreSQL 16, deploy 22/22, tools 10/10.
- `bash deploy/build.sh` (the exact Render build) completes on the integrated tree.
- **Full launcher boot** against two empty PostgreSQL 16 databases: role created, both migration sets applied,
  all three children ready in 17 s, zero restarts over a 105 s run. Through the gateway: internal routes 404
  with any edge header and token-gated bare; request ids minted (client value ignored); no `.map` served;
  per-IP limiter fires on `/labs/api/*`; with a session the DevSecOps `sandbox.html` and Red Team
  `target-frame.html` carry their dedicated sandboxed CSP and their parent pages carry `frame-src 'self'`.

## Not in this patch

- **Part B** (assessment integrity: option shuffling, first-attempt scoring, no early severity/titles) — awaiting
  the owner's approval (decision 2.3); implement on `integrity/patch-2026-10-23`.
- **Part C** (authenticated live walkthrough + load test on staging) — needs a staging deploy and a test account.
- Everything in `claude/threatready-decisions-needed.md` (legal pages, TOTP, DPDP, durable storage, custom
  domain/origins, WAF, Turnstile/Sentry credentials, Render plan, `autoDeploy`).
- Known cosmetic: InterviewPrep has 5 pre-existing ESLint errors (CI skips its lint step with a comment);
  `packages/contracts` `npm test` exits 1 with "no test files" at baseline; a benign
  "Cannot use a pool after calling end" line can appear during InterviewPrep shutdown if a pool-refill job is
  mid-flight. GitHub Actions still pinned by tag (no GitHub access from the build box).
