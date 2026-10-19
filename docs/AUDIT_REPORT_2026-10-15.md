# ThreatReady: full production-readiness and security audit

**Date:** 15 Oct 2026
**Scope:** the whole `ThreatReady/` folder (10 apps, about 70k lines), the running local stack (`localhost:5173` and the APIs behind it), and the code compared against the *Architecture Decision Document* (139 pp.) and the *Architecture Summary* (13 pp.).
**Method:** this was read-only. Seven parallel reviews were run: onboard, InterviewPrep, Labs + Attack Reasoning, SOC, the Red Team / ThreatWall / DevSecOps labs, deploy/secrets/deps, and ADD compliance. Live probing and test, typecheck and audit runs were added on top. Findings marked **Verified** were reproduced with a script or timing measurement; the others were confirmed by reading the code. No project file was changed apart from adding this report.

---

## 0. Verdict

**Not ready for production.** InterviewPrep and the onboard identity core are well engineered. The platform around them has problems:

1. **Four places where a single learner request can freeze or crash the server for every user.** Three are regex denial-of-service (ReDoS) bugs and one is unbounded memory. All the lab apps run inside the gateway process, so a freeze or crash takes down sign-in, InterviewPrep and every lab together.
2. **Data loss is built into the current deploy.** Uploads, PDFs and all lab, SOC and Red Team progress live in `/tmp` on a Render free instance that sleeps every 15 minutes.
3. **The repo cannot be deployed as it stands.** Five sub-folders are nested git repos, three of them with other people's remotes. Render would clone them as empty folders.
4. **The deploy contradicts the ADD and your own legal pages.** The pages say AWS Mumbai, India data residency, MFA, backups, account deletion and age checks. The deploy is Render Singapore, Neon and Resend, with none of those controls.
5. **V1.0 scope is incomplete.** Razorpay billing, Attack Reasoning, staff TOTP and an audit log are all missing.

---

## 1. Top 15 launch blockers (fix in this order)

| # | Sev | Area | Issue | Where |
|---|---|---|---|---|
| 1 | CRIT | Labs (AWS) | ReDoS in IAM policy wildcard matching. One `iam.updatePolicy` freezes the event loop for more than 40 s, and the bad policy persists, so it re-hangs on every status read. **Verified.** | `threatready-lab-001/server/policy.ts:20-23` |
| 2 | CRIT | SOC | ReDoS in the log query language: `q=command_line:********#` takes 3.4 s per event, across thousands of events. **Verified.** | `soc/server/engine/query.js:31-38` |
| 3 | CRIT | Red Team | ReDoS in the terminal: `grep '(a+)+$'` compiles learner input with `new RegExp`. **Verified** (1.7 s at n=26, doubling per character). | `red_team_lab/web/server/terminal.ts:180` |
| 4 | CRIT | SOC + Red Team + Labs | Per-session state and log streams in memory have no limit. The gateway heap is capped at **96 MB**. A 6-hour SOC case holds 62 MB. 200 Red Team ticket posts grow state to 66 MB, and each later response is about 62 MB of JSON. **Verified.** | `soc/server/engine/cases.js:23,51`, `red_team_lab/web/server/target.ts:282`, `engine.ts:51,369`, `threatready-lab-001/server/engine.ts:521-539`, `render.yaml:11` |
| 5 | CRIT | Repo | 5 nested `.git` repos (InterviewPrep, soc, threatready-lab-001, ThreatWall, DevSecOps-Simulation) with no `.gitmodules`. A root commit records gitlinks, Render clones empty folders, and `deploy/build.sh` fails. Uncommitted work sits in the nested repos. | repo layout |
| 6 | CRIT | Secrets | A live Anthropic key, Google/GitHub OAuth secrets, DB passwords and `INTERNAL_API_TOKEN` are in local `.env` files on a world-readable (`rwxrwxrwx`) NTFS mount. They are gitignored, but rotate them if the folder was ever shared, zipped or synced. | `InterviewPrep/.env`, `Threatready-landing-page-main/apps/api/.env`, `attack-reasoning/.env`, `threatready-lab-001/.env` |
| 7 | HIGH | Deploy | All file and lab data is in `/tmp` on Render free. It is wiped on every sleep (15 min idle), deploy or crash. `pdf_status='ready'` then points to missing files, which gives 500s. | `deploy/start.mjs:50,59,61,162`, InterviewPrep `reports.service.ts:407` |
| 8 | HIGH | Deploy/Auth | The client IP can be spoofed. The gateway trusts `true-client-ip`, then `cf-connecting-ip`, then the **first** `X-Forwarded-For` entry, so every per-IP rate limit (login, OTP, sign-up, trial) can be bypassed. | `deploy/gateway.mjs:33-34`, onboard `common/throttle.ts:15-20`, `config.ts:35` |
| 9 | HIGH | Deploy/Auth | There is no CAPTCHA in production. `ALLOW_NO_CAPTCHA=true` is set whenever Turnstile keys are absent, and `render.yaml` doesn't declare them. With #8 this allows bot sign-ups, inbox bombing and LLM budget drain. | `deploy/start.mjs:149/259`, `render.yaml` |
| 10 | HIGH | Admin | The admin console has no TOTP and no audit log. It exposes every user's email, session IPs, user agents and AI spend. ADD L6/LLD-16 requires TOTP. | onboard `authz/authz.ts:17-25`, `admin/admin.service.ts:239-302` |
| 11 | HIGH | SOC | The live log stream (EventSource) and all downloads use absolute `/api/...` paths. Under `/labs/soc/` they hit the onboard API and get 404/401, and EventSource retries forever. **Confirmed in the built bundle.** | `soc/client/src/CaseView.jsx:102`, `pages/ReportPage.jsx:19`, `components/ReportPanel.jsx:125-126` |
| 12 | HIGH | Red Team | The production CSP breaks the lab. The `srcdoc` iframe inherits `script-src 'self'`, so the inline NAV_SHIM and every XSS payload are blocked, and links fall through to a `frame-ancestors 'none'` block. It works locally only because Vite sends no CSP. | `red_team_lab/web/client/src/tools.tsx:24,128`, `deploy/gateway.mjs:74-87` |
| 13 | HIGH | InterviewPrep | The pg Pool has no `'error'` listener and there is no `uncaughtException` handler. A Neon idle-connection drop kills the API and worker process, and sessions get stuck in `evaluating` for 24 h. | `InterviewPrep/apps/api/src/platform/db/database.ts:41-47` |
| 14 | HIGH | InterviewPrep | An unauthenticated upload endpoint buffers 6 MB in memory **before** the HMAC check. About 50 parallel posts OOM the 512 MB instance. | `InterviewPrep/.../dev-storage.controller.ts:9,28-35` |
| 15 | HIGH | Legal | The privacy, security and DPA pages claim AWS Mumbai residency, KMS encryption, 30-day backups, a 12-month audit trail, mandatory MFA, age verification and account deletion within 30 days. **None of these is true of the code or the deploy.** The sub-processor list omits Render, Neon and Resend. The "[Registered Office Address]" placeholder is still there. | `Landing_Page-main/privacy.html`, `security.html`, `dpa.html`, `terms.html` |

---

## 2. Severity scoreboard

| App | Critical | High | Medium | Low/Info |
|---|---|---|---|---|
| Deploy / repo / secrets / CI | 2 | 7 | 11 | 6 |
| Onboard (identity, admin) | 0 | 3 | 9 | 12 |
| InterviewPrep | 0 | 4 | 10 | 16 |
| Labs hub (TR-CLOUD-001) + Attack Reasoning | 1 | 3 | 10 | 12 |
| SOC | 2 | 3 | 4 | 12 |
| Red Team (TR-RED-001) | 2 | 3 | 8 | 5 |
| ThreatWall + DevSecOps | 0 | 2 | 1 | 6 |
| Architecture (ADD) gaps | — | 7 "Contradicted / Missing" blockers | | |

---

## 3. Security issues (all apps)

### 3.1 Denial of service / emulator containment
The ADD's risk #2 says "one emulator containment bug becomes a real vulnerability". This is now a real risk, because every lab runs inside the gateway process (`deploy/start.mjs:58-66`, `hosted.ts:130-138`).

| Sev | Issue | Location | Fix |
|---|---|---|---|
| CRIT | IAM policy glob becomes a backtracking regex | `threatready-lab-001/server/policy.ts:20-23` | Linear two-pointer wildcard matcher; cap at 5 wildcards and 256 characters |
| CRIT | SOC query `*` becomes `.*` | `soc/server/engine/query.js:31-38` | Collapse `*` runs; use an `indexOf`-chain glob; cap query length at 300 |
| CRIT | Red Team `grep` uses the learner's regex directly | `red_team_lab/web/server/terminal.ts:180` | RE2 or fixed-string only; cap stdin and pattern length |
| CRIT | Unbounded state: SOC streams (6 h of synchronous generation), Red Team tickets/sessions/history with full bodies, Labs `labEvents`/`timeline`/`cloudtrail`, and runs per user | see #4 above | Ring buffers, LRU/TTL eviction, caps per user, delta responses |
| HIGH | `POST /labs/soc/api/demo/start` without a nonce creates a new case and stream every call | `soc/server/demo/service.js:41-60` | One active demo per user; at most 3 open attempts |
| MED | Polynomial regexes in Red Team detectors (`\s*`, `on\w+\s*=`); 426 ms per request on a 16 KB input. **Verified.** | `red_team_lab/web/server/target.ts:157,218,290,329` | Cap detector input at 512 characters; anchor the regexes |
| MED | `find -name '('` throws a SyntaxError and returns 500 | `red_team_lab/web/server/terminal.ts:188` | Escape all metacharacters; try/catch |
| MED | A self-replicating stored-XSS `postMessage` nav loop; the message source isn't checked when the frame is unmounted | `red_team_lab/web/client/src/tools.tsx:24,77-82` | Always check `e.source`; throttle |
| MED | No rate limit at all on `/labs/*` and `/ar/*` (gateway limits only cover proxied APIs) | `deploy/gateway.mjs`, labs `app.ts` | Token bucket per user and per IP |
| MED | Each SSE connection has its own 1 s interval; a closed case never ends its SSE | `soc/server/index.js:162-188` | Shared ticker per case; `res.end()` on close; cap connections per user |
| MED | InterviewPrep SSE polls the DB every 2 s per tab on a 5-connection pool with no `connectionTimeoutMillis` | `InterviewPrep/.../controllers.ts:97-119` | Cap streams per user; LISTEN/NOTIFY |
| MED | DOCX zip bomb: worker heap 256 MB on top of a 200 MB main heap on a 512 MB box; no limit on decompressed size | `InterviewPrep/.../extractors.ts:59-82` | Pre-scan the central directory; worker limit of about 96 MB; one extraction at a time |

### 3.2 Authentication, session and admin
| Sev | Issue | Location |
|---|---|---|
| HIGH | Client-IP spoofing (see #8) | `deploy/gateway.mjs:33`, onboard `throttle.ts`, `auth.ts:129` |
| HIGH | No CAPTCHA in production (see #9); README says it "refuses to boot", which is false | `deploy/start.mjs`, `README.md:83` |
| HIGH | Admin has no TOTP, no audit log and no fresh-session requirement; admin is granted to any verified email in `ADMIN_EMAILS` | onboard `authz.ts`, `admin.service.ts` |
| MED | 5-minute Better Auth cookie cache plus a 30 s app identity cache: a revoked or stolen session keeps working for about 5.5 min after a password reset, while the UI says "other sessions signed out". `@FreshSession()` exists but is unused. The internal identity endpoint doesn't pass `disableCookieCache`. | onboard `auth.ts:105`, `authz.ts:50`, `platform.controller.ts:32-35` |
| MED | The reset OTP can be brute-forced: 6 digits, 3 tries per code, codes re-requestable through `send-verification-otp type=forget-password` with no per-email issuance cap | onboard `auth.ts:118-156` |
| MED | One `INTERNAL_API_TOKEN` shared in both directions by every app. A leak from any app can read every user's summaries and AI usage and call identity for any cookie. | onboard `internal-token.ts`, all apps |
| MED | `BETTER_AUTH_SECRET` reused by InterviewPrep to sign storage URLs (cross-purpose key) | `deploy/start.mjs` interviewEnv, `fs-storage.adapter.ts:81` |
| MED | Child processes inherit `...process.env`, including the **owner** DB URL, the other app's DB, the Anthropic and Resend keys and the role password. That cancels the least-privilege RLS role. | `deploy/start.mjs:222,246` |
| MED | Gateway runs without `NODE_ENV=production`, so the in-process SOC uses a hard-coded session secret and would honour `DEV_USER` / `SOC_SIM_TEST` (`x-test-user` header impersonation) if either were ever set | `render.yaml`, `soc/server/config.js:15,19,28`, `auth.js:91` |
| MED | Identity resolver: negative results aren't cached, any junk cookie triggers an onboard DB call, and `cache.clear()` at 5000 entries can be forced. Three separate resolver instances. | `threatready-lab-001/server/identity.ts:60-89` (also AR, InterviewPrep `identity.adapter.ts:57-71`) |
| MED | Standalone Red Team: unset `APP_ORIGIN` enables DEV_LOGIN with a **public hard-coded `APP_SECRET`**, and user id = sha256(display name), so impersonation is trivial | `red_team_lab/web/server/index.ts:11-13`, `identity.ts:283` |
| LOW | OAuth tokens stored in plaintext (`encryptOAuthTokens` not set) | onboard `auth.ts:88-97` |
| LOW | `/signout` signs out on GET page load (logout CSRF), and trial users are orphaned | onboard `SignOutPage.tsx:15-25` |
| LOW | In-memory forgot-username limiter is flushable at 10k entries and lost on restart | onboard `account.controller.ts:61-71` |
| LOW | SOC webhook HMAC uses an empty key when `TR_WEBHOOK_SECRET` is unset | `soc/server/attempts.js:417` |
| LOW | ThreatWall setup password: 32-bit FNV hash in localStorage on the platform origin, which a password manager may autofill with the real ThreatReady password | `ThreatWall/src/lib/hash.ts:5-13` |

### 3.3 Origin isolation / XSS blast radius
| Sev | Issue | Location |
|---|---|---|
| MED-HIGH | **Single origin for everything.** The onboard API (including `/api/admin/*` and `/api/auth/get-access-token`), InterviewPrep and every lab share one origin and one cookie. Any XSS in any lab means account takeover, or admin data if the victim is an admin. | `deploy/gateway.mjs:103-108` |
| MED | DevSecOps runs learner-edited JS with `new Function` in the top-level origin, and `/labs/devsecops` gets `'unsafe-eval'` | `DevSecOps-Simulation/src/content/shopflow.ts:233`, `threatready-lab-001/server/hosted.ts:32-38` |
| MED | With `COOKIE_DOMAIN=threatready.io`, the cookie reaches **every** subdomain, including the marketing site and any dangling CNAME | onboard `auth.ts:132` |
| LOW | Red Team target iframe is sandboxed (good) but not on a separate registrable domain as the ADD requires | `tools.tsx:128` |
| LOW | Source maps are published (onboard, InterviewPrep with 25 `.map` files) | `apps/web/vite.config.ts` |
| LOW | HSTS has no `includeSubDomains`; the two CSPs (`_headers` vs gateway) have drifted apart | `gateway.mjs:89`, `apps/web/public/_headers` |

### 3.4 Assessment integrity (cheating)
| Sev | Issue | Location |
|---|---|---|
| HIGH | **ThreatWall and DevSecOps grade in the browser.** Every check predicate and expected value ships in the JS bundle, and progress sits in localStorage with no user id, so marks can be forged. This breaks the ADD rule that answer keys never reach the browser. | `ThreatWall/src/tasks/level0-4.ts`, `DevSecOps-Simulation/src/content/labs/*.ts` |
| HIGH | ThreatWall and DevSecOps progress keys aren't namespaced by user. After user A signs out, user B on the same browser continues A's lab. | `ThreatWall/src/state/store.tsx:8,73`, `DevSecOps-Simulation/src/store.ts:19` |
| MED | TR-CLOUD-001 sends all 10 finding titles (the answer list) from minute zero | `threatready-lab-001/server/engine.ts:519,554` |
| MED | TR-CLOUD-001 "evidence inspected" is whatever the client claims; `L4.logs` can be satisfied with 2 raw POSTs | `engine.ts:85,91`, `scenario.ts:173` |
| MED | Wrong-report penalty capped at 10, plus an error-code oracle; line 90 `wrongReports++` is dead code | `engine.ts:90,488,527` |
| MED | After submission the full answer key is revealed, then reset allows a perfect replay; the profile shows the best score | `engine.ts:581`, `app.ts:183` |
| MED | Red Team: the correct remediation is always the **first** option; true severity is shown before the learner reports it; mode switching isn't penalised | `red_team_lab/web/server/scenario.ts:38-160`, `engine.ts:185,277,281` |
| MED | SOC: unlimited retakes with best score kept, stable option ids, and per-question credit revealed (an oracle) | `soc/server/attempts.js:22-28,394`, `grading.js:46-56` |
| LOW | Red Team canary flags share one 8-hex suffix | `red_team_lab/web/server/fixture.ts:53` |

### 3.5 LLM cost and abuse (InterviewPrep)
| Sev | Issue | Location |
|---|---|---|
| HIGH | Failed LLM calls that were **billed** (truncated, schema-invalid, timed out) are recorded as `status='failed'` and excluded from every budget and admin total. Users can push spend past the caps, and the admin console under-reports. | `llm.service.ts:162-167,197-205`, `anthropic-llm.adapter.ts:391` |
| MED | `finalize` has no cap; pg-boss retries scoring 5 times and re-runs every LARGE batch each time; `retryReport` is unlimited (`retryReportCount` is never checked) | `llm.service.ts:15-18`, `reports.service.ts:256-302` |
| MED | The global $60/day breaker only blocks *new* interviews; live turns and finalize keep spending. Unverified emails are accepted. | `llm.service.ts:134-142`, `identity.adapter.ts:90` |
| MED | Job expiry (300 s / 600 s) is shorter than worst-case LLM time (120 s × 3 SDK attempts), so pg-boss re-runs the job while the first attempt still runs and the spend doubles | `pgboss-queue.adapter.ts:11-12` |
| MED | Sonnet 5.5 adaptive thinking uses up the tight `max_tokens` (1500 to 6000), so output truncates, then retries, then gets under-counted | `anthropic-llm.adapter.ts:375-388` |
| MED | **Cost model mismatch:** SMALL is configured as `claude-haiku-4-5` ($1/$5 per MTok). The ADD costs SMALL as Haiku 5.5 at $0.10/$0.50. The ADD's per-interview ($0.13) and S1 LLM budget ($313–406/month) are understated. | `InterviewPrep/apps/api/src/modules/ai/pricing.ts:3-4`, `config.ts:51-52` |
| LOW | Concurrent `clarify` calls each run an LLM stream before the count check | `turn.service.ts:184-224` |
| LOW | The user's real first name goes into the stored first question and is then sent to the LLM (bypasses redaction) | `turn.service.ts:252,269` |
| — | No replay set gates prompt or model changes (ADD L15) | — |
| ext | The landing demo posts to `threatready-db.onrender.com/api/demo/evaluate`, which isn't in this repo and is limited only by client-side `sessionStorage`. That is unauthenticated LLM cost exposure. | `Landing_Page-main/assets/js/demo.js:11` |

---

## 4. What will break in production (Render deploy as configured)

1. **Data disappears.** Render free sleeps after 15 min idle and wipes `/tmp`. That loses lab, SOC and Red Team progress, uploaded resumes and report PDFs. The onboard profile then shows zeros.
2. **Report PDFs 500** after any restart, because `pdf_status` stays `ready` and the file is gone.
3. **SOC live logs never stream and downloads fail** (absolute `/api` paths).
4. **Red Team browser and XSS exercises don't work** under the gateway CSP.
5. **The whole platform OOM-restarts.** 512 MB holds three Node processes (96 + 120 + 200 MB heaps plus overhead, about 375 MB at rest), and every lab is in the 96 MB gateway heap. A few SOC learners with long-open cases is enough.
6. **Crash loops look healthy.** `/healthz` always returns 200 and Render doesn't check `/readyz`, so an onboard or InterviewPrep crash loop or failed migration goes unnoticed.
7. **Graceful shutdown is skipped.** SOC registers its own `SIGTERM` handler, which calls `process.exit(0)`, at import. The launcher never gets to stop its children or flush the other stores.
8. **Migrations and `ALTER ROLE` run on every boot.** A cold start chains Render wake, Neon wake, role setup and two migrations, and any failure means exit and a loop.
9. **The deploy won't build from git** because of the nested repos. The onboard CI is under a sub-folder, so it wouldn't run, and it's broken anyway: `INTERNAL_API_TOKEN` is missing, so the API can't boot in e2e, and the wait loop masks the failure.
10. **`render.yaml` has `autoDeploy: true` with no CI gate,** so every push goes straight to production.
11. **`INTERVIEW_APP_URL` is set to `/`** instead of `/interview-prep/`, which gives wrong "next" labels and links. (onboard finding L12, `start.mjs:251`)
12. **POSTs to labs and AR return 403** if users arrive via a hostname other than `PUBLIC_URL` (single exact `appOrigin`).
13. **Labs and AR bundles built outside `build.sh`** fall back to `http://localhost:5173` for sign-in.
14. **Landing site CTAs** point at `https://threatready.io/app/...`. The apex is GitHub Pages static hosting, so these are dead links. The pilot form has no `FORMSPREE_ID`, so it falls back to `mailto:`.
15. **Licence breach risk.** `InterviewPrep/apps/api/assets/interviewer.glb` (Renderpeople) is **tracked in git** in the nested InterviewPrep repo. Earlier history had it in a public path. `start.mjs`'s "install from secret file only if missing" never runs because the file exists.
16. **Stale extra blueprints** (`soc/render.yaml` on Node 22, `threatready-lab-001/render.yaml` with no env) would create broken services if applied.
17. **Drizzle snapshot for migration 0002 is missing,** so the next `db:generate` emits `ADD COLUMN role` again and fails on apply.
18. **JSON stores silently wipe themselves.** A corrupt or truncated file makes the store start empty, and the next save overwrites it (labs `store.ts:13`, SOC `store.js:36-40`).
19. **The SOC "Records reset daily at 00:00 UTC" text is wrong** in hosted mode; records reset on every restart instead.
20. **soc tests fail on Node 24.** 2 of 94 fail with `ECONNRESET`, while production runs Node 24.

---

## 5. Bugs (functional)

| App | Bug | Location |
|---|---|---|
| InterviewPrep | Sessions stuck in `evaluating` after a crash or transition conflict; only the 24 h sweeper recovers them | `turn.service.ts:79-176`, `jobs.service.ts:74` |
| InterviewPrep | One failed statement aborts the whole sweep transaction, which repeats every 5 min (`retryLimit 0`) | `jobs.service.ts:65-91` |
| InterviewPrep | `purgeOldFiles` scans every document every 5 min with no index or limit (O(n) forever) | `documents.service.ts:293-312` |
| InterviewPrep | A malformed `cursor` gives a 500 (RangeError) | `interview.service.ts:97` |
| InterviewPrep | The 64 KB JSON limit rejects a 30k-character non-Latin JD as `RESUME_TOO_LARGE` | `bootstrap.ts:77` |
| InterviewPrep | The pdfkit Helvetica font garbles non-Latin text, `→`, `≥` and CJK in reports | `report.pdf.ts` |
| InterviewPrep | Missing index on `evaluations.user_id` | migrations |
| Onboard | Race on personal workspace creation (no unique constraint; `LIMIT 1` with no `ORDER BY`) | `tenancy/tenancy.ts:11-45` |
| Onboard | Shutdown handlers registered twice, so `pool.end` runs twice | `main.ts:49,60-61` |
| Onboard | The entitlement and quota system (`/features/:key/launch`, `PLAN_LIMITS`) is dead code: shown in the UI, never enforced | `features/*`, `apps/web/src/lib/api.ts:71` |
| Onboard | Abandoned trial and unverified accounts are never cleaned up; unverified sign-ups squat emails and usernames | — |
| Red Team | An `alg:none` or truncated JWT makes `timingSafeEqual` throw a RangeError and return 500, in exactly the JWT exercise | `server/target.ts:149` |
| Red Team | `findingId:'constructor'` or `objectiveId:'constructor'` causes a TypeError and a 500 (prototype keys) | `engine.ts:141-192`, `scenario.ts:166,205` |
| Red Team | `sqlmap --dump` output disagrees with the real UNION dump; `-L`/`-c` are accepted and ignored | `terminal.ts:250,329` |
| Labs | `requestId` values like `__proto__` or `constructor` return `replayed:true` without running the action | `threatready-lab-001/server/app.ts:161-163` |
| Labs | `GET /api/*` writes to the store (`upsertUser`) | `app.ts` |
| SOC | A non-array value for a set-type field crashes grading **after** the round is consumed | `grading.js:49`, `cases.js:489` |
| SOC | The heartbeat `beats` Map grows forever | `attempts.js:177-187` |
| SOC | Searches against a shared read-only preview case are recorded | `cases.js:668-675` |
| SOC | Two different collateral-penalty models (25% vs 5 pts capped at 20) | `attempts.js:222`, `cases.js:241` |
| AR | The internal summary ignores `userId` and returns hard-coded catalog stats, so every profile is identical | `attack-reasoning/server/app.ts:36-50` |
| AR / Labs | `new URL(APP_PATH[key], a.url)` throws and crashes the header if the registry URL is relative or empty | `client/src/shell.tsx:15` |
| Red Team | The red team app is mounted without `internalToken`, so the platform profile may not show red team progress | `threatready-lab-001/server/hosted.ts:147-149` |
| Dev | DevSecOps and Red Team both use Vite dev port 5180 | `vite.config.ts` |

---

## 6. Architecture compliance (ADD, 9 Oct 2026)

| Requirement | Status | Note |
|---|---|---|
| One NestJS modular monolith, api + worker roles | **Contradicted** | 6 apps in 2 languages (2 NestJS, 4 Express, plain JS, 2 browser-only) glued by a gateway |
| AWS Mumbai: ECS Fargate, RDS (PITR), S3, SES, Cloudflare Pro, ALB | **Contradicted** | Render free (Singapore), Neon, Resend, `/tmp`. No PITR, no RPO/RTO, no India data residency |
| Secrets in SSM / Secrets Manager; GitHub OIDC | **Contradicted** | Render env vars |
| Better Auth in-process, email verify, revoke on reset, safe OAuth linking | Implemented | |
| **Staff TOTP** | **Missing** | |
| Host-only session cookie on the API host | Contradicted | Shared across subdomains (or a single origin on Render) |
| Origin check (CSRF) | Partial | Done in IP and the labs; onboard Nest POSTs rely on Better Auth and SameSite only |
| Default-deny guards with a CI route test | Implemented (OB, IP) | Labs use ad-hoc checks |
| RLS backstop with a no-BYPASSRLS role | Partial | IP and OB only; lab state is in JSON |
| Generated cross-user 404 test | Implemented (IP) | None for labs |
| **Razorpay: HMAC webhook, idempotent events, reconcile; PaymentPort** | **Missing** | V1.0 scope |
| Entitlements driven by subscriptions | Partial | Free-quota counting only; onboard quota code is dead |
| **audit_log** | **Missing** | |
| Ports: Llm/Storage/Queue/Cache/Email | Implemented (IP) | No PaymentPort; AuthPort is cross-service |
| Module-boundary check in CI | Partial | ESLint vendor ban in IP only; IP has no CI |
| pg-boss transactional enqueue, retries, DLQ | Implemented (IP) | Some jobs retry 1–2 times; no DLQ alarm |
| S3 quarantine, validate, clean, presigned URLs | Logic yes / deploy no | `STORAGE_DRIVER=fs` in `/tmp` |
| PII redaction before LLM | Implemented | Leak: first name in the greeting |
| LLM tiers, caps, `llm_call_log`, breaker | Implemented, with deviations | Haiku 4.5 pricing is 10x the ADD; breaker is soft; failed calls are uncounted |
| Replay set gating model changes | Missing | |
| **Attack Reasoning (rubric LLM, score in code)** | **Missing** | Stub with "coming soon" |
| Server-authoritative labs; answer keys server-only | Partial / **Contradicted** | Cloud, Red Team and SOC are server-side; ThreatWall and DevSecOps are client-side |
| Lab state in PostgreSQL (`lab_instances`/`lab_state`/`lab_events`) | **Contradicted** | JSON files in `/tmp` |
| Lab rate limits (in-flight lock, 20/s, 300/min) | **Missing** | |
| Sandboxed target on a separate registrable domain, per-instance host | Partial | `srcdoc` sandbox on the app origin |
| WASM SQLite for SQLi | Missing | Regex simulation instead (safe, but a different design) |
| Sentry with scrubbing, `request_id` | Partial | IP only; off in the deploy |
| CloudWatch, EMF, alarms, 180-day logs in India (CERT-In) | **Missing** | |
| CI gates (lint, typecheck, boundaries, integration, secret scan, dependency scan, image scan, scenario solver) | Partial | OB only, and broken |
| OpenTofu IaC, staging, WAF canary, manual approval | Missing | `autoDeploy: true` straight to production |
| Retention (files 30 days, lab events 90 days, logs 180 days, LLM log 1 year) | Partial | File purge only |
| Self-service export / deletion | **Missing** | Contradicts the privacy policy |
| DPDP consent ledger and withdrawal | Partial | Per-session AI consent version only |
| **Under-18 block** | **Missing** | Privacy page claims age verification |
| V1.0 roadmap: platform, interview, Attack Reasoning, lab core, SOC | Partial | Billing and AR missing; V1.1/V1.2 labs (Cloud, DevSecOps, Network, Red Team) built ahead of V1.0 items |

---

## 7. Secrets, PII and repo hygiene

- **Real secrets on disk** (gitignored, never committed at the root): an Anthropic key (`InterviewPrep/.env`), Google OAuth secret (`GOCSPX…`) and GitHub OAuth secret (`Threatready-landing-page-main/apps/api/.env`), DB passwords, a `BETTER_AUTH_SECRET`, and one `INTERNAL_API_TOKEN` shared by four `.env` files. The mount is `rwxrwxrwx`. **Rotate them if the folder was ever shared.**
- **PII in local data:** `threatready-lab-001/data/store.json` (8 user ids and names), `red_team_lab/web/data/store.json` (4 emails), `soc/data/*.json` (a real-looking user), `InterviewPrep/apps/api/var/storage` (about 40 resumes and report PDFs). Ignored today; purge them before packaging or sharing.
- **Nested `.gitignore` gaps:** DevSecOps, ThreatWall and `deploy/` don't ignore `.env`; attack-reasoning and threatready-lab-001 don't ignore `.env.*` or `*.log`. The root `.gitignore` has **no effect inside nested repos.**
- **Nested repos:** three point to other people's GitHub remotes (PRABU-S-19/soc, PRABU-S-19/ThreatWall, Surendharsure46/DevSecOps-Simulation). Settle ownership and IP before vendoring.
- `soc/client/dist` is tracked in git and is stale (base `/`).
- `AKIAFAKETRAININGKEY2` and other fake keys will trip GitHub push protection, so add an allowlist.
- **Local dev exposure (this machine):** all APIs bind `0.0.0.0` (`*:3200, 3100, 4000, 4100`), and the Postgres container is published on `0.0.0.0:55432`, so they are reachable from your LAN. Bind them to `127.0.0.1`. The Vite servers are correctly on 127.0.0.1, and Vite blocked `@fs` traversal (`/etc/passwd`, `.env?raw` returned 403). *The traversal probes in `.logs/onboard-web.log` are from this audit, not an attacker.*
- `start-all.sh`:
  - `stop` kills any process on those ports and runs `pkill -f "src/main.ts worker"`.
  - It loads `InterviewPrep/.env` by **sourcing it as shell code**.
  - It has no `set -e`, runs no migrations, and starts a possibly stale onboard `dist`.

---

## 8. Tests, typecheck, dependencies

| App | Tests | Typecheck | `npm/pnpm audit` (prod) |
|---|---|---|---|
| attack-reasoning | 7/7 ✅ | ✅ | 0 |
| threatready-lab-001 | 46/46 ✅ | ✅ | 0 |
| red_team_lab/web | 19/19 ✅ | ✅ | 0 |
| ThreatWall | 46/46 ✅ | ✅ | 0 |
| DevSecOps-Simulation | **no tests** (about 150 KB of engine logic) | ✅ | 0 |
| soc | 92 ✅ / **2 ❌** (`session.test.mjs:110`, `variants.test.mjs:65`, ECONNRESET on Node 24) | n/a | 0 |
| InterviewPrep web | 46/46 ✅ | ✅ | 7 moderate (mammoth → sprintf-js DoS is **runtime-reachable**; esbuild dev-only) |
| InterviewPrep api (unit) | 31/31 ✅ | ✅ | ↑ |
| Onboard | e2e not run (needs Postgres) | ✅ | 1 moderate (esbuild, dev-only) |

**Test gaps:**
- No tests for hosted mounting, base paths, the gateway CSP, SSE through the hub, store corruption, ReDoS or size limits, prototype keys, admin routes or the internal identity token.
- No test for LLM failed-call accounting.
- e2e targets the four-origin dev layout, never the single-origin gateway.

**Version drift:**

| Item | Versions in use |
|---|---|
| Express | 4 (SOC, mounted in an Express 5 gateway) |
| React | 18 / 19 |
| Vite | 5 / 6 / 7 / 8 |
| TypeScript | 5.9 / 6 / 7 |
| NestJS | 11 / 12 |
| vitest | 3 / 5 |
| Node | 22 pinned, 24 in production |

---

## 9. Done well (keep these)

- **InterviewPrep:**
  - Fail-closed `@Route` guard with contract permissions checked at boot.
  - Owner-scoped repos plus RLS (`SET LOCAL ROLE tr_app_user`) and a generated cross-user test.
  - Quarantine and magic-byte upload pipeline.
  - Redaction before the LLM, `<untrusted_*>` delimiters, verbatim-quote checks.
  - Advisory-locked budget reservations, transactional pg-boss enqueue, idempotent submissions.
  - Sentry scrubbing and error envelopes.
  - No `dangerouslySetInnerHTML`.
- **Onboard:**
  - Default-deny guard with a CI route test.
  - Strict `next=` origin allowlist with loop detection; no open redirect.
  - No account enumeration; hashed OTPs.
  - Safe OAuth linking; RLS with `FORCE`.
  - A role check for BYPASSRLS; production config validation.
- **Labs, Red Team and SOC engines:**
  - Server-authoritative with closed action whitelists.
  - Clone-then-commit state, projected views with answer keys stripped.
  - Ownership 404s plus IDOR tests.
  - No `eval`, `child_process` or real network calls driven by input; the Red Team iframe is sandboxed with no `allow-same-origin`.
- **Everywhere:** constant-time internal-token comparison, loopback-only `/internal` routes, atomic temp-file-then-rename writes, `verify-full` TLS to Neon, CSP with no inline scripts allowed.

---

## 10. Remediation plan

**Phase 0: today (hygiene, under a day)**
1. Rotate the Anthropic, Google, GitHub and DB secrets if the folder has been shared. Run `chmod 600` on the `.env` files or move them off the NTFS mount.
2. Bind the local APIs and Postgres to 127.0.0.1.
3. `git rm --cached` `interviewer.glb`, purge it from history, and add `**/interviewer.glb` to every `.gitignore`.
4. Resolve the nested repos: commit and push each one, settle ownership, then vendor into one root repo (or proper submodules). Fix the nested `.gitignore` files.

**Phase 1: stop the platform-wide outages (2–4 days)**
5. Replace the three regex engines with linear glob matchers or RE2, and cap input lengths.
6. Cap every per-session array and stream (ring buffers), add LRU eviction for SOC streams, cap demos, attempts and runs per user, and return deltas instead of full histories.
7. Add per-user and per-IP rate limits on `/labs/*` and `/ar/*`; cap SSE connections.
8. Run the labs as a **supervised child process** with their own heap (like onboard and IP), or at least add `uncaughtException` logging. Make `/healthz` reflect child readiness. Remove the SOC `SIGTERM` handler in hosted mode. Set `NODE_ENV=production` for the gateway.
9. InterviewPrep: add `pool.on('error')`, `connectionTimeoutMillis`, upload verification before buffering, and an `evaluating` lease.

**Phase 2: make production correct (1–2 weeks)**
10. Persistence: move lab, SOC and Red Team state to Postgres (`lab_instances`/`lab_state`/`lab_events`, as the ADD says) and files to S3/R2. Alternatively use a paid instance with a disk as a stopgap. Back up corrupt store files instead of overwriting them.
11. Fix the client IP (trust only the edge-overwritten header, or the right-most hop), make Turnstile mandatory in production, and add per-email OTP and login caps.
12. Fix the SOC `BASE_URL` paths and the Red Team target origin/CSP (separate sandbox origin). Fix `INTERVIEW_APP_URL`.
13. LLM accounting: count billed failures, cap finalize and retries, make the global breaker hard, set job expiry above the worst case, and re-baseline costs using the actual Haiku 4.5 pricing (or switch SMALL to the model the ADD assumes).
14. Child-process env allowlist, a separate secret per purpose, and a separate internal token per app and direction.
15. Root CI matrix (typecheck, tests, build, audit, gitleaks) gating deploy; turn off `autoDeploy` until it passes. Fix onboard CI (`INTERNAL_API_TOKEN`, a wait loop that fails properly). Regenerate the drizzle 0002 snapshot. Delete the stale `render.yaml` files.

**Phase 3: V1.0 scope and compliance (multi-week, per ADD)**
16. Staff TOTP (Better Auth `twoFactor`), `@FreshSession` on admin routes, `audit_log`, and a shorter cookie cache.
17. Razorpay plus PaymentPort, a webhook HMAC over the raw body, idempotent event store and reconciliation; subscription-driven entitlements, with the onboard quota API wired to the apps.
18. The Attack Reasoning engine (rubric LLM, score in code).
19. DPDP: under-18 block, account export and deletion, consent ledger with withdrawal, retention jobs.
20. Either move to AWS ap-south-1 as the ADD and legal pages say, **or** rewrite the privacy, security and DPA pages and the sub-processor list to match Render, Neon and Resend. Fill the registered office address.
21. Move ThreatWall and DevSecOps grading server-side, or label them "practice only". Namespace localStorage by user. Move the DevSecOps `new Function` into a sandboxed worker or iframe and drop `'unsafe-eval'`.
22. Assessment integrity: shuffle options and option ids per run, uncapped or locked penalties, first-attempt scoring, and reveal severity only after the learner has reported it.
23. Observability: Sentry on in the deploy, `request_id` across all apps, alarms, and log retention.

---
*Generated by a read-only audit. Items marked "Verified" were reproduced; the CSP breakage (#12) was reasoned from the CSP spec and should be confirmed in a browser behind the gateway.*
