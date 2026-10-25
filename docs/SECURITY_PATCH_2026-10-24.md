# ThreatReady security and UI/UX patch — 24 Oct 2026 (second round)

This round builds on `docs/SECURITY_PATCH_2026-10-23.md` (the collaborator's patch) and the UI/UX branch
(`docs/THREATREADY_COMPREHENSIVE_UI_UX_AUDIT.md`). It closes the rest of the 64 findings of the 23 Oct audit
(`audit/2026-10-23/THREATREADY_FINDINGS.csv`, ids TR-01 to TR-64), the regressions the review found in the first
patch (ids such as IP-REG1, UX-REG0, OPS-REG0) and the UI/UX review issues (UI-*, BIZ-*, SEC-*). Eight teams each
fixed one part of the tree, a reviewer checked each part, and a fix-up round followed. An integration pass then
checked the parts against each other.

The UI/UX branch's design decisions stand: visual design, tokens, the lab strip contract (`--tr-labnav-h`) and
FUNC-17 (hosted labs hide their own Sign out).

## Read this before you deploy

1. **Back up both Neon databases first** (a Neon branch is enough). Onboard migrations 0008, 0009 and 0010 change
   existing rows and cannot be undone (see "Migrations").
2. **Migrations run on their own at boot**, under the launcher's migration lock: onboard 0006 to 0010, then
   InterviewPrep 0013, 0011 and 0014 (this order is intended). Nothing to run by hand on Render.
3. **The build installs dev dependencies on purpose.** Render applies `NODE_ENV=production` to the build too, and
   `npm ci` then skips vite and typescript. `deploy/build.sh` now runs `npm ci --include=dev` and
   `pnpm install --prod=false`. The running service still has `NODE_ENV=production`.
4. **New optional settings in Render** (all have safe defaults): `SENTRY_DSN`, `INTERVIEW_DATA_STORAGE_LOCATION`,
   `TRIAL_ENABLED`. They are declared in `render.yaml` with `sync: false`, so a Blueprint sync never overwrites
   what you set in the dashboard. Leave them empty if you have not decided.
5. **The first boot of a new release is held at `/healthz` 503** until the migrations are done and both APIs have
   answered once. If the release is broken, Render keeps the old version.
6. **After the deploy, read the launcher log once** (see "After the deploy").

## What learners will notice

**Sign-in and account (onboard)**
- Five wrong passwords for one username pause password sign-in for that username: 15 minutes first, doubling up to
  24 hours. The owner is emailed once when a pause starts. A password reset by email lifts it. (TR-03)
- A browser that has signed in to a username before is not paused by other people's wrong passwords: it has its own
  count (an HttpOnly cookie, `tr.signin_device`, 180 days), and only its own five wrong passwords pause it. A new
  browser is still paused with the username. (final review SEC-2, BIZ-10)
- Sign-in, sign-up and code requests that are refused now say when to try again. Codes are limited to 5 per hour
  per email and network, and 20 per hour per email; a browser that has signed in to the account is held to the
  first limit only. (TR-52, ONB-REG2, ONB-REG3, UX-REG7, final review SEC-2)
- Signing out from onboard's own account menu goes straight to the sign-in page (no "Your session ended"). (final review UI-1)
- "Continue as a guest" is gone unless `TRIAL_ENABLED=true`. Existing guests can still sign out; the retention job
  removes them after 7 days. (TR-30)
- Signing out from a ThreatReady page is one click again. A `/signout` link opened cold or from another site asks
  first. (UX-REG1, ONB-REG1; this makes line 25 of the 23 Oct patch doc true again for platform pages.)
- Username/password accounts now show their username as their name. Names chosen freely at sign-up are replaced
  (see migrations 0009 and 0010). (TR-40)
- Google and GitHub sign-in work as before; ThreatReady no longer stores their access tokens. (TR-39)

**InterviewPrep**
- While an interview is paused, the question and its clarifications are hidden. Pauses and tab switches are counted
  and shown in the report. The number of pauses is unlimited by default (`INTERVIEW_MAX_PAUSES=0`). (TR-24)
- A report that keeps failing stops offering "Generate report again" after the retry cap. The page says to contact
  support and shows the reference. (UX-REG4)
- A report stopped by the platform's daily AI budget says "Your report will be generated later". It is generated
  automatically after 00:00 UTC; no retry button is shown. (IP-REG0, AR-REG0)
- Cancelling an interview after its documents were analysed still counts toward the monthly quota. The cancel
  question now says so. (TR-08 / IP-06)
- Rate-limit messages say when to try again. Short waits (10 s or less) are retried automatically. A shared network
  that is busy signing many people in gets its own message. (TR-52)
- The consent notice names no storage location until `INTERVIEW_DATA_STORAGE_LOCATION` is set. History lists the
  learner's documents, which can be deleted. Original files are deleted after 30 days. (TR-13)
- The dashboard shows the 2D photo interviewer; three.js loads only in the interview room. Software-rendered WebGL
  falls back to the photo interviewer, and reduced motion stops the render loop. (TR-32, TR-57)
- The 3D model can be downloaded 30 times per learner per UTC day. (TR-47)
- Unknown or someone else's interview links show "This interview doesn't exist or isn't yours". (UI-12, TR-56)
- Oversized pasted text (over 30,000 characters) and crafted DOCX files are refused with a clear message. (TR-06, TR-36)
- Layout fixes at 320-400 px: file rows, sub-navigation ("New"), dashboard cards. (UI-6, UI-7, UI-9, UI-14)

**Attack Reasoning**
- From this release on, a question that was shown and then skipped, left to expire, or replaced at the open-question
  cap counts as answered with 0. Skips made before the deploy never count. (BIZ-09)
- An unanswered ready question is skipped after 24 hours; the page says when. Replacing an open question at the cap
  asks first. (TR-42)
- Manual retries of a failed generation or evaluation are capped at 2 per stage. Starting questions is limited to 10
  per hour. (TR-08)

**Labs**
- The Cloud lab keeps 5 runs per learner and lab; the best and the active run are always kept. A completed run is
  read-only. (TR-15, BIZ-03)
- Each catalog card and lab says where progress is kept: "Saved to your ThreatReady account" while the launcher
  saves lab state, "kept on the ThreatReady lab server" when it cannot, or "kept in this browser" for DevSecOps,
  ThreatReady Firewall and AI Security. (BIZ-06, TR-27, TR-45)
- SOC: at most 3 live consoles per learner (a 4th tab offers Retry). When the stream is refused the case is refreshed
  every 5 s. A signed-out learner sees one notice with "Reload page". (TR-12, BIZ-11)
- Red Team: wrong reports and fixes now cost points. The reference severity is hidden until the learner commits
  their own. A delivered report is read-only. Common grep patterns work again. The XSS exercises run on the
  platform (the lab page may now frame its own sandboxed target). Runs are capped at 20 per lab. (TR-28, SEC-2,
  BIZ-02, UX-REG6, TR-44, TR-15)
- DevSecOps, ThreatWall and AI Security: when the account cannot be confirmed, progress is kept in this tab only and a
  notice says so. AI Security totals count passed scenarios only. Speed bonuses use wall-clock time. ThreatWall
  appliance passwords use PBKDF2 (a login takes about 0.25 s, longer on slow phones). These labs stay dark-only.
  (SEC-1, BIZ-04, BIZ-08, SEC-3, BIZ-10, TR-64)
- Many learners behind one network address (a classroom) opening the labs together after a restart are served in
  waves, not refused. (IP-REG1, UX-REG0, LAB-REG2)

**Marketing site**
- Every "Sign in", "Start free" and "Browse the labs" link opens https://threatready.onrender.com. Pricing says the
  platform is free and nothing is on sale. Wide tables scroll inside a focusable region. (BIZ-01, BIZ-07, UI-2, UI-15)

## What admins will notice

- Names of username/password accounts in the admin console change to the username (migrations 0009/0010).
- SOC and Red Team progress shows in the profile and the admin console. (TR-26)
- AI cost totals include billed calls that failed, priced by the exact model. (TR-09, IP-REG2)
- Every console figure (time, locations, AI cost and calls, new users) covers the same whole UTC days: the chosen
  range is widened to the midnights around it, and the range the API returns says so. (final review BIZ-09)
- Server errors from both APIs reach Sentry once `SENTRY_DSN` is set; onboard uses a small built-in reporter. (TR-14)
- `/healthz` is 503 "starting" during migrations and, on a new release, until both APIs are up. (TR-14)
- Lab, SOC and Red Team progress survives restarts through the launcher's Postgres copy (schema `threatready_ops`).
  The launcher logs when a file is held back (too big, refused, or owned by a newer instance). (TR-15)

## Fixed in this round

Short list by finding. "Done" means fixed and covered by a test unless noted.

**Platform, gateway and deploy**
- TR-02: client IP from `CLIENT_IP_SOURCE` (default `xff-rightmost` with `TRUSTED_PROXY_HOPS=2`); spoofed left-most
  entries do not change it.
- TR-14: health check holds a broken release; migrations under an advisory lock; Sentry forwarded.
- Final review SEC-1: the gateway refuses compressed request bodies (`Content-Encoding` other than `identity`) with
  415 for every app, so no JSON parser inflates them (body-parser advisory GHSA-27r3-jxmh-p828; not crashable on
  Node 24, closed anyway). Browsers never send compressed bodies.
- TR-15: Postgres mirror of lab state (restore before load, upload every 30 s and on SIGTERM, SOC flushed first,
  newest instance wins, conflict and rejected copies kept 30 days). The size cap is on the stored (gzip) copy.
  The launcher sets `TR_STATE_DURABLE` only while saved progress really survives a restart.
- TR-18, OPS-REG0: 15 MB body cap (declared and chunked), 180 s idle timeout, one request per framing.
- TR-19 (partial): explicit per-child env allowlist; neither app gets the other's secrets or the owner DB URLs.
  Per-direction internal tokens are not done (owner decision).
- TR-34: publish guard (`scripts/publish-check.mjs`) and `.gitignore` for the licensed model and keys.
- TR-50: CSP `connect-src` without `data:` (`blob:` stays for the 3D interviewer's textures).
- OPS-REG2: child tunables forwarded by prefix; test hooks never reach production.
- One labs identity resolver is shared by the labs gate and the hosted Red Team lab (one onboard lookup per request).
- CI: browser-lab job (DevSecOps, ThreatWall, AI Security: typecheck, tests, platform build, AI Security
  `npm audit --omit=dev`) and onboard unit tests.

**Onboard**
- TR-03 race-free per-username lockout; TR-11 deleted users get 401, not 500; TR-29 activity counted once per user;
  TR-30 guests off by default; TR-38 one personal workspace per user; TR-39 provider tokens not stored, retention
  job; TR-40 display name is the username; TR-41 `?next=` allow-list; TR-52 every 429 says when; TR-56 one redirect
  on session loss; ONB-REG0 to ONB-REG4; UX-REG1, UX-REG7; UI-8, UI-11, UI-13, UI-15; BIZ-06 progress copy.
- Final review: SEC-2 and BIZ-10 known-browser exemption from the username lock and the per-email code cap,
  `/is-username-available` off; BIZ-01 retention keeps Google/GitHub users; BIZ-08 launches move with 0008; BIZ-09
  whole-UTC-day admin ranges; UI-1 one-step sign-out; UI-4 account-menu avatar contrast (all five `platform.css`).

**InterviewPrep**
- TR-04 linear redaction; TR-06 DOCX bomb checks (JSZip parity); TR-07 upload signature first, single-use links;
  TR-08 finalize ceiling (`AI_FINALIZE_SOURCE_CAP_USD`), quota counts cancelled-after-analysis; TR-09 failed calls
  priced; TR-13 documents list, delete, neutral consent text; TR-21 grader-injection caps; TR-22 phone redaction;
  TR-23 evaluating lease; TR-24 pause and tab-switch integrity; TR-25 bounded SSE and purge; TR-35 token types;
  TR-36 4xx instead of 500; TR-46 separate rate classes; TR-47 model download quota; TR-51 build-only tools out of
  runtime deps; TR-52 Retry-After everywhere; TR-62 config refuses log email in production.
- Web: TR-13, TR-24, TR-31 no endless loader, TR-32, TR-52, TR-53, TR-54, TR-56, TR-57, TR-63 stable tests;
  UX-REG4; UI-6, UI-7, UI-9, UI-12, UI-14.
- IP-REG0 to IP-REG6, AR-REG0, UX-REG0 (InterviewPrep part).

**Attack Reasoning**
- TR-08 per-stage retry caps and budget checks before any state change; TR-10 demand-driven pool, off outside
  production; TR-21 stage outputs escaped; TR-42 expiry and `expiresAt`; TR-49 standalone security headers; TR-59,
  TR-60, TR-61 docs; BIZ-09 skip rule, not retroactive; AR-REG1 to AR-REG5; UX-REG0, UX-REG3, UX-REG9; IP-REG1
  classroom-safe resolver; OPS-REG0 body cap on the `/v1` proxy; UI-3, UI-4, UI-10, UI-11.
- The `/v1` proxy forwards the engine path when the app is mounted under `/ar`.

**Labs hub and SOC**
- TR-01 SOC sessions cannot be forged or replace the platform user; TR-12 SOC stream fallback; TR-15 ring buffers
  and run caps; TR-16 `sandbox.html` always sandboxed (`frame-ancestors 'self'`, every URL spelling); TR-17 API
  path checks case-insensitive; TR-26 SOC and Red Team summaries; TR-43 accepted design (comment only); TR-44 Red
  Team page may frame same-origin documents; TR-45 reset copy; BIZ-03, BIZ-06, BIZ-11; LAB-REG1, LAB-REG2,
  OPS-REG1, UX-REG0, IP-REG1; UI-5, UI-11.

**Red Team**
- TR-28, SEC-2, BIZ-02, UX-REG6, UX-REG5, LAB-REG1, TR-15 run cap and unique run numbers, TR-26 token-checked
  summary, TR-33 and UI-16 light contrast, TR-44 sandboxed target frame, TR-49 standalone secret rules, IP-REG1
  classroom-safe resolver (same rules as the labs hub: 16 per client, 5 s wait, 12 h known-good).

**DevSecOps, ThreatWall, AI Security**
- TR-16 tests; TR-20 jspdf 4.2.1 / dompurify 3.4.17, express to devDependencies; TR-27 practice-only label;
  TR-33, TR-55 phone-width checks; TR-64 dark-only; LAB-REG0, UX-REG2, UX-REG8, SEC-1, SEC-3, BIZ-04, BIZ-05,
  BIZ-08, BIZ-10, UI-1; ThreatWall PBKDF2 passwords.

**Changed in the integration pass**
- InterviewPrep's identity resolver keeps the same 12 h known-good window as the labs, Red Team and Attack
  Reasoning resolvers (was 10 minutes).
- DevSecOps has an `npm test` script; CI uses it.
- `render.yaml` declares `TRIAL_ENABLED`; `deploy/README.md` lists `INTERVIEW_DATA_STORAGE_LOCATION` and
  `TRIAL_ENABLED`.

## New settings

All are optional. Set them in Render → Environment only if you want a value other than the default. `0` turns a
limit off where noted. The launcher forwards each app's settings by name (`deploy/child-env.mjs`).

| Setting | Default | App | Where |
|---|---|---|---|
| `SENTRY_DSN` | unset (no error tracking) | onboard, InterviewPrep | Render (declared) |
| `INTERVIEW_DATA_STORAGE_LOCATION` | unset (no location named) | InterviewPrep | Render (declared) |
| `TRIAL_ENABLED` | `false` | onboard | Render (declared) |
| `SENTRY_ENVIRONMENT`, `RELEASE` | NODE_ENV, Render commit | onboard | Render |
| `SIGNIN_LOCKOUT_FAILURES` / `SIGNIN_LOCKOUT_MINUTES` | 5 / 15 (0 failures = off) | onboard | Render |
| `OTP_ISSUE_PER_IP_PER_HOUR` / `OTP_ISSUE_PER_EMAIL_PER_HOUR` | 5 / 20 (0 = off) | onboard | Render |
| `ACTIVITY_PING_PER_USER_PER_MINUTE` / `_PER_IP_PER_MINUTE` | 20 / 600 (0 = off) | onboard | Render |
| `AUTH_GET_SESSION_PER_IP_PER_MINUTE` | 0 (session reads exempt) | onboard | Render |
| `RETENTION_INTERVAL_HOURS` / `_UNVERIFIED_DAYS` / `_GUEST_DAYS` | 24 (0 = off, max 576) / 30 / 7 | onboard | Render |
| `IDENTITY_MAX_IN_FLIGHT` / `IDENTITY_MAX_IN_FLIGHT_PER_CLIENT` | 50 / 8 (0 = off) | InterviewPrep | Render |
| `AI_FINALIZE_SOURCE_CAP_USD` | 1 (0 = off) | InterviewPrep | Render |
| `INTERVIEW_MAX_PAUSES` | 0 (unlimited) | InterviewPrep | Render |
| `RATE_LIMIT_SCALE` | 1 (0 turns tier-2 limits off) | InterviewPrep | Render |
| `INTERVIEW_RATE_GENERAL_PER_MIN`, `_UPLOADS_PER_HOUR`, `_JD_TEXTS_PER_HOUR`, `_TEXT_EDITS_PER_HOUR`, `_TURNS_PER_MIN`, `_CREATES_PER_HOUR` | 600, 10, 20, 30, 40, 10 (0 = off) | InterviewPrep | Render |
| `REASONING_RATE_CREATES_PER_HOUR` | 10 (0 = off) | InterviewPrep | Render |
| `INTERVIEW_UPLOAD_FAILURES_PER_IP` / `INTERVIEW_UPLOAD_CONCURRENCY` | 30 per 10 min / 16 (0 = off) | InterviewPrep | Render |
| `INTERVIEW_MODEL_DOWNLOADS_PER_DAY` | 30 (0 = off) | InterviewPrep | Render |
| `REASONING_POOL_ENABLED` | on in production, off elsewhere | InterviewPrep | Render |
| `REASONING_POOL_IDLE_TARGET` / `_DEMAND_DAYS` / `_MAX_ITEMS` | 2 / 7 / 40 | InterviewPrep | Render |
| `REASONING_MAX_RETRIES` / `REASONING_READY_TTL_HOURS` | 2 / 24 (0 = no cap / never) | InterviewPrep | Render |
| `REASONING_USER_DAILY_EVALUATIONS` / `_REFILLS` | 20 / 60 (now accept 0 = no limit) | InterviewPrep | Render |
| `CLIENT_IP_SOURCE` / `TRUSTED_PROXY_HOPS` | `xff-rightmost` / 2 | gateway | Render |
| `GATEWAY_MAX_BODY_BYTES` / `GATEWAY_UPSTREAM_TIMEOUT_MS` | 15 MB / 180000 (0 = off) | gateway | Render |
| `GATEWAY_BOOT_HEALTH` | `auto` (`wait`, `migrations`) | launcher | Render |
| `STATE_MIRROR`, `_INTERVAL_MS`, `_MAX_BYTES`, `_TABLE` | on, 30000, 8 MB gzip, `threatready_ops.lab_state_files` | launcher | Render |
| `LABS_IDENTITY_MAX_IN_FLIGHT` / `_MAX_PER_CLIENT` | 50 / 16 (0 = off) | labs hub (also hosted Red Team) | Render |
| `LABS_MAX_RUNS_PER_LAB` | 5 (0 keeps all) | labs hub | Render |
| `SOC_MAX_STREAMS_PER_USER` | 3 (0 = no limit) | SOC | Render |
| `AR_IDENTITY_MAX_IN_FLIGHT` / `AR_IDENTITY_MAX_PER_CLIENT` | 50 / 16 (0 = off; was `..._IN_FLIGHT_PER_CLIENT`) | Attack Reasoning | Render |
| `REDTEAM_MAX_RUNS_PER_LAB` | 20 (0 = off) | Red Team | Render |
| `TR_STATE_DURABLE` | set by the launcher only | labs, SOC | never set by hand |
| `SOC_INTERNAL_TOKEN`, `LABS_TRUST_CLIENT_IP_HEADER`, `AR_TRUST_PROXY`, `AR_TRUST_CLIENT_IP_HEADER`, `REDTEAM_TRUST_CLIENT_IP_HEADER`, `REDTEAM_IDENTITY_MAX_*` (16 per client), `REDTEAM_RATE_*` | unset / standalone defaults | standalone servers only | the app's `.env` |
| `STATE_MIRROR_TEST_DATABASE_URL`, `CAPTCHA_API_PORT`, `CAPTCHA_STUB_PORT`, `*_E2E_PORT`, `PLAYWRIGHT_MODULE`, `TW_LAB_KEY`, `E2E_PORT` | — | tests only | shell |

Each app's `.env.example` lists its own settings; the gateway and launcher ones are in `deploy/README.md`.

## Migrations and their data effects

Both apps use drizzle migrations; each runs once, in order, at boot. They were applied from scratch and on top of a
copy of the current local schema (with test rows), as a non-superuser owner, under the launcher's least-privilege
role setup. A fresh database and an upgraded one end with the same schema.

**Onboard** (`Threatready-landing-page-main/apps/api/drizzle/`)
- `0006_signin_failures`: new table for the per-username lockout (a hash of the name, never the name). The app role
  may read, add, change and delete rows.
- `0007_activity_last_ping`: new table, one row per user, deleted with the user. The app role cannot delete rows.
- `0008_personal_membership_unique`: **deletes duplicate personal memberships** (role learner or trial), keeping each
  user's oldest one, then adds a unique index. Institute roles are not touched. The user's feature launches recorded
  under a duplicate are first moved to the kept workspace (FORCE row-level security on `feature_launches` is lifted
  for that one statement, inside the migration transaction). The workspace a deleted duplicate belonged to is left
  without members; the retention job removes it later. (final review BIZ-08)
- `0009_strip_provider_tokens`: **clears stored Google/GitHub access, refresh and ID tokens** (password rows are not
  touched; sign-in still works). For username/password accounts it **sets the display name (`users.name`) to the
  stored display username, or the username** when there is none.
- `0010_username_display_names`: sets `display_username` to the username where it was empty or different (a version
  that differs only in upper/lower case is kept), then sets `users.name` to it for username/password accounts. In
  effect, **every username/password account is renamed to its username** in the case the user typed it. Accounts
  that only use Google or GitHub keep their name.

**InterviewPrep** (`InterviewPrep/packages/db/migrations/`, applied as 0013, 0011, 0014, 0015)
- `0013_reasoning_retries`: two counters on Attack Reasoning attempts, 0 for existing rows.
- `0011_interview_integrity`: pause and tab-switch counters on interviews (`{}` for existing rows) and two indexes
  for the retention sweeps.
- `0014_reasoning_skip_counts`: existing attempts get `skip_counts = false` (their skips never count as 0); new
  attempts default to `true`.
- `0015_reasoning_submit_refused`: a nullable `submit_refused_at` on Attack Reasoning attempts, null for existing
  rows. A submission refused by the daily evaluation quota or an AI budget sets it once; the question then stays
  open until `REASONING_READY_TTL_HOURS` after the next 00:00 UTC instead of expiring into a counted 0 (final
  review BIZ-07).
- All four only add columns or indexes; no table is rewritten.

**Launcher** (`deploy/`): creates `threatready_ops.lab_state_files` and `threatready_ops.launcher_boots` in the
InterviewPrep database if missing. They hold lab state copies and one fingerprint per release.

## Deploy steps

1. Back up both Neon databases (create a branch of each).
2. Optional: in Render → Environment set `SENTRY_DSN`, `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (both), and
   `INTERVIEW_DATA_STORAGE_LOCATION` once legal has decided it. Leave `TRIAL_ENABLED` empty unless guests are wanted.
3. Deploy the branch. The build runs `deploy/build.sh`; the launcher runs the migrations and starts the APIs.
4. Wait for the deploy to go live. If `/healthz` stays 503 on a working release (APIs slow on the free instance),
   set `GATEWAY_BOOT_HEALTH=migrations` and redeploy.
5. Locally: run both apps' migrations before restarting the stack, or onboard sign-in returns 500
   (`audit/2026-10-23/resume/scripts/restart-stack.sh` does this; by hand: `node --env-file=.env dist/db/migrate.js`
   in `Threatready-landing-page-main/apps/api`, and `node dist/migrate.js` in `InterviewPrep/packages/db` with
   `DATABASE_URL` set). The local databases are still at the pre-patch migrations.

## After the deploy

- In the launcher log, find `[gateway] client IP: ... CF-Connecting-IP position in X-Forwarded-For`. If it names a
  position other than 2, set `TRUSTED_PROXY_HOPS` to it (or `CLIENT_IP_SOURCE=cf-connecting-ip`).
- `state mirror: ready (N file(s) restored ...)` should appear; then a catalog card says "Saved to your ThreatReady
  account".
- Expected warnings only: missing CAPTCHA keys and missing `SENTRY_DSN` until you set them.
- Checks that need the live service (not run here): six sign-ins with rotating spoofed IP headers, the sixth gets 429;
  a 20 MB POST gets 413; progress in the Cloud lab, SOC and Red Team survives a restart; on `/labs/redteam/`, an XSS
  payload in the Browser tab runs inside the sandboxed target frame; 40 learners from one network open `/labs/` and
  `/ar/` at once without errors; a Google sign-in and a username sign-in after the migration; the marketing CTAs open
  the platform.

## Decisions for the owner

Merged from all teams. Each item says what is decided now and what needs a choice.

**Legal and business**
1. Data residency: set `INTERVIEW_DATA_STORAGE_LOCATION` once the true statement is known. `privacy.html` and
   `dpa.html` still describe AWS Mumbai while the platform runs on Render (Singapore), Neon, Resend and Anthropic.
2. Pricing and terms copy (BIZ-07) needs sign-off: free use, nothing on sale, terms §4.1/4.2. Pick one source for free
   limits: onboard says 3 interviews and 10 reasoning per month, InterviewPrep enforces 5 interviews per month and
   Attack Reasoning 20 evaluations per day. The site states no numbers until then.
3. Retention periods: never-verified username/password sign-ups 30 days (only accounts with no other sign-in method,
   no session and no activity; Google/GitHub users are never removed by this rule, final review BIZ-01), guests 7 days, sessions
   1 day after expiry, codes at expiry, sign-in failure rows 1 day. Confirm and add them to the privacy policy.
4. Licensed 3D model: is 30 downloads per learner per day acceptable under the licence (TR-47)? It is served
   `private, no-store`, so the caching the audit suggests (TR-57) is not used; pick one.
5. Username/password accounts are renamed to their username (TR-40). Confirm before deploying.

**Trial and accounts**
6. Guests stay off (`TRIAL_ENABLED=false`). A real trial needs a product decision on whether the apps accept guests.
7. Sign-out: one click from platform pages trusts the referrer. Residual risk: a crafted link on an app page can sign
   a viewer out (a nuisance, not a breach). The stronger fix is a POST sign-out in every app; decide if it is worth it.
8. Classrooms behind one address still hit Better Auth's per-IP limits on sign-up (5 per hour) and sign-in
   (5 per minute). Raising them needs a decision, ideally together with Turnstile.

**Security infrastructure**
9. Turn on Turnstile (both keys) before real launch; until then sign-up relies on rate limits. It also covers the
   residual lockout risk (final review SEC-2): someone who knows a username can still pause its password sign-in on browsers that
   never signed in to it, and with the account's email and four or more networks can use up the hour's reset codes
   for such browsers (Better Auth also lets three wrong guesses spend the latest code). The owner's own browsers are
   not affected, and username listing through `/is-username-available` is off (sign-up still tells a taken name, at
   5 per hour per IP).
10. Create a Sentry project and set `SENTRY_DSN`. The in-process labs, AR, SOC and Red Team have no Sentry SDK (a
    dependency decision).
11. TR-19: per-app, per-direction internal tokens (proposal: derive them from `INTERNAL_API_TOKEN` per direction).
    Needs one coordinated change in the launcher and every app; until then the shared token stays.
12. TR-38: whether to add a BYPASSRLS worker role and FORCE RLS on Neon, give InterviewPrep a non-owner login, and
    drop the legacy accounts/sessions/verifications tables in the InterviewPrep database (irreversible).
13. Dependency bumps that need a lockfile change: body-parser and multer in InterviewPrep (mitigated in code); whether
    the CI audit gate also covers dev dependencies (AI Security lists dev-only findings). dompurify 3.4.17 was
    accepted although it is 12 days old (the only fixed release).

**Hosting**
14. Durable uploads and PDFs: they still live on the instance disk and are lost on restart. AWS S3 works today
    (`STORAGE_DRIVER=s3`); Cloudflare R2 needs presigned PUT uploads in InterviewPrep first.
15. Cold start: the free instance can take over 30 s after idle, and every marketing link points at it. Consider a
    paid instance or a keep-warm ping.
16. Client IP hops: check `TRUSTED_PROXY_HOPS` after the first deploy (see above).
17. Health check: if a working release keeps restarting before both APIs start, use `GATEWAY_BOOT_HEALTH=migrations`.
18. Lab state lives in JSON files copied to Postgres. If the learner count grows, move lab runs to database tables.
    During a deploy overlap the newest instance wins; the old one's late changes are kept as conflict copies for
    30 days, never merged.
19. A branded host means changing the Render domain, `PUBLIC_URL`, OAuth redirect URIs and the site's
    `PLATFORM_URL` together. Do not use app.threatready.io. Keep the legacy demo service up for `index.html#demo`.

**Learning rules and product**
20. Attack Reasoning skip rule (BIZ-09): shown-then-skipped, expired or replaced questions count as 0 from this
    release on, not before. Alternative: average answered questions only and show a completion rate.
21. Replacing a question at the open-question cap uses two of the 10 hourly starts. Accepted as rare.
22. Attack Reasoning scores for hiring or certification, a per-question time box, larger pool buckets, flagging
    widely seen questions (TR-42). Pool values: demand window 7 days, idle target 2, ceiling 40 per bucket.
23. Cloud lab keeps 5 runs per lab (`LABS_MAX_RUNS_PER_LAB`, was 10); the best run and the best completed run
    always stay, so a completed lab stays completed. SOC keeps 50 abandoned attempts per learner and
    all closed ones. SOC counts as completed once all three level badges are earned. Confirm.
24. Red Team: switching to a more-assisted guidance mode is recorded and shown, not penalised. Decide if it should be.
25. DevSecOps, ThreatWall and AI Security still grade in the browser and are labelled practice-only (TR-27).
26. The four browser labs are dark-only; ThreatWall's simulated appliance keeps its light vendor look. Confirm. The
    "small screen" notice dismissal is not per account; say if it should be.
27. ThreatWall PBKDF2 at 600,000 iterations (about 0.25 s per login, 1-2 s on low-end phones); can be lowered.
28. Planned catalog cards (TR-NET-002, TR-RED-002/003) still show as coming soon. Keep or hide.
29. Interview pauses are unlimited by default; set `INTERVIEW_MAX_PAUSES` if they should be capped.
30. `AI_FINALIZE_SOURCE_CAP_USD` is $1 per session (about five full scorings). Decide who may run the support script
    that extends it for one session.
31. The dashboard shows the 2D interviewer instead of the 3D scene; design should confirm.
32. TR-43 (self-reported lab inspection) is accepted design; revisit if labs ever issue certificates.

## Still open

- TR-19 per-direction tokens and TR-38 database role hardening (decisions 11 and 12).
- TR-44 runs in code and in server tests; a browser check under the production CSP is a post-deploy check.
- The Attack Reasoning attempt page shows a generic error, not a not-found page, for an unknown attempt id (the AR
  part of UI-12 was not assigned).
- The live end-to-end checks the teams suggested (see "After the deploy") need the running service and a test
  account; they were not added to `e2e/`.
- InterviewPrep first-load JS is about 208 KB gzipped; a constants-only export from the contracts package would
  roughly halve it.

## Verified

Integration run of 25 Oct 2026 (`audit/2026-10-23/resume/scripts/run-tests.sh`, one step at a time), all passing:

- Typecheck: InterviewPrep (all workspaces), onboard (all packages), Lab Simulations, Attack Reasoning, Red Team,
  DevSecOps, ThreatWall, AI Security; `node --check` on the deploy, scripts and e2e files.
- Builds: every build `deploy/build.sh` runs, with `NODE_ENV=production`, and the gateway bundle.
- Tests: Lab Simulations 78, Attack Reasoning 35, Red Team 45, SOC 115, DevSecOps 35, ThreatWall 65, AI Security 214,
  InterviewPrep web 108, InterviewPrep API 238 (1 skipped: needs a real AI key), onboard API units and routes 19, onboard
  web and contracts 9, onboard end-to-end 39 (live API on a scratch database, least-privilege app role), deploy 41
  (gateway, launcher, state mirror, migration lock, against PostgreSQL), publish guard tests 3 and the guard itself on
  the publishable tree, marketing site check (17 pages) and its 9 tool tests.
- Browser (Chromium and Firefox): DevSecOps 26/26, AI Security 10/10, ThreatWall platform 6/6 and the 30-task
  walkthrough 30/30, Red Team end-to-end 7/7.
- Migrations: both sets from scratch and as an upgrade of the current schema with test rows, as described above.
- Secret scan of every added line: no real key, token or password; only test placeholders.
