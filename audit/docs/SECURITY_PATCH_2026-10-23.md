# ThreatReady security patch — 23 Oct 2026

Security fixes only. No product, concept, UX or dependency changes. Every `package.json` and lockfile is
unchanged, so `npm ci` / `pnpm install --frozen-lockfile` and `deploy/build.sh` work exactly as before.
This patch addresses the findings of the 23 Oct audit (which superseded `AUDIT_REPORT_2026-10-15.md`).

## Deploy notes (read before deploying)

1. **New env vars (optional, recommended):** `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are now declared in
   `render.yaml`. CAPTCHA turns on only when **both** are set; otherwise the launcher logs a warning and keeps
   `ALLOW_NO_CAPTCHA=true` (so the deploy does not break). `NODE_ENV=production` is now set for the gateway too.
2. **New migrations run automatically on boot:** onboard `0005_append_only_audit.sql` (revokes UPDATE/DELETE on
   `admin_audit_log`, DELETE on `activity_days`/`user_locations`); InterviewPrep `0010_bill_failed_calls.sql`
   (`ai_spend_today_usd()` now counts billed-but-failed LLM calls).
3. **Derived secrets:** the launcher derives `STORAGE_SIGNING_SECRET` and `SOC_SESSION_SECRET` from
   `BETTER_AUTH_SECRET` with HKDF. Nothing to configure; existing storage URLs signed with the old key expire on
   their own TTL (60–300 s).
4. **OAuth tokens are now encrypted at rest.** Existing plaintext provider tokens (if any) become unreadable until
   that user signs in with Google/GitHub again; sign-in itself is unaffected.
5. **New tunables** (all with safe defaults): `LABS_RATE_PER_MIN` (120/user), `LABS_RATE_IP_PER_MIN` (300/IP),
   `AR_RATE_*`, `REDTEAM_RATE_*`, `REASONING_USER_DAILY_EVALUATIONS` (20), `REASONING_USER_DAILY_REFILLS` (60).
   Set a limit to `0` to disable it. Raise the per-IP limits if many learners share one NAT.
6. **Learner-visible changes (all intentional):** ThreatWall and DevSecOps progress is now per account (existing
   un-namespaced progress is migrated once to the first account that opens the lab); `/signout` asks for a click
   when opened cold (the in-app menu still signs out in one click); Red Team `grep` refuses pathological regexes
   with a grep-style error; SOC live queries are capped at 300 characters.

## Fixed — platform-wide outage (CRITICAL)

| Finding | Fix | Verified |
|---|---|---|
| ReDoS in IAM policy wildcard matcher (`threatready-lab-001/server/policy.ts`) | Regex-free two-pointer glob (`*`, `?`, same semantics); patterns > 256 chars or > 5 `*` rejected by `validatePolicy` | 12-star pattern vs 200-char resource: < 1 ms (was > 20 s); parity test vs old matcher |
| ReDoS in SOC query language (`soc/server/engine/query.js`) | Linear `globMatch()`; live `?q=` capped at 300 chars (400 `query_too_long`) | `command_line:********#` over 2000 events: 17 ms (was 13 s+) |
| ReDoS in Red Team terminal `grep` (`red_team_lab/web/server/terminal.ts`) | `safeRegex()`: ≤ 128 chars, no quantified groups/backrefs/lookarounds/stacked quantifiers, ≤ 1 unbounded quantifier; try/catch compile; scan ≤ 2000 lines / 16 KB. `find -name` uses a linear glob | `(a+)+$` on 40 chars: 0.01 ms; `find -name '('` → grep-style error, not 500 |

## Fixed — exposure and abuse (HIGH)

| Finding | Fix |
|---|---|
| Internal routes internet-reachable (gateway loopback guard ineffective behind Render) | Guard now requires loopback **and** no edge header (`x-forwarded-*`, `cf-connecting-ip`, `true-client-ip`, `cf-ray`, `rndr-id`, `x-real-ip`, `forwarded`, `via`), applied to `^/(api|labs|ar)(/.*)?/internal(/|$)` case-insensitively (covers sub-mounted labs). Token check remains the authoritative control. |
| No rate limiting on `/labs/*`, `/ar/*`, Red Team | Dependency-free token buckets per user and per IP in the labs hub (shared with every hosted lab), Attack Reasoning and Red Team; 429 + `Retry-After`; static assets exempt |
| Client-IP header spoofable for in-process apps; AR proxy preserved a learner-supplied value | Gateway stamps `x-threatready-client-ip` in a **global** first middleware (`cf-connecting-ip` → `true-client-ip` → leftmost XFF → socket, `net.isIP`-validated, always overwritten); AR proxy always overwrites from `req.ip`; hop-by-hop headers stripped |
| Identity resolver: no negative cache, `cache.clear()` at 5000, unbounded in-flight | 10 s negative cache keyed by sha256(cookie), oldest-first eviction, coalesced lookups, cap 50 in flight → 503 retryable (labs, AR, Red Team, InterviewPrep) |
| Attack Reasoning evaluations billed under `finalize` (no caps) | New `reasoning` budget: stage 1 checked against the per-user daily cap and the global breaker; per-user daily evaluation quota (`REASONING_USER_DAILY_EVALUATIONS`); `expert` maps to the `advanced` pool bucket; on-demand generation billed to the requesting learner; refills never grow a bucket past target; per-user daily refill cap |
| Billed-but-failed LLM calls excluded from budgets | Usage attached to truncation/schema/refusal errors; `fail()` records cost; budget sums and `ai_spend_today_usd()` include failed calls that carry a cost |
| Global breaker only blocked new interviews | Breaker applies to every policy: live turns refused at 100 %, finalize at 110 % grace |
| `/v1/dev-storage/upload` buffered 6 MB before HMAC, no rate limit | Order is now IP rate limit (20 / 10 min) → HMAC + expiry from the query string → Content-Length sanity → multer. Presigned POST URLs carry `policy`/`signature`/`expires` in the query |
| Children inherited the whole environment (owner DB URL, other app's keys) | Explicit per-child allowlist (`childEnv()`); onboard no longer receives `DATABASE_MIGRATION_URL`, Anthropic key or Interview DB; InterviewPrep no longer receives `BETTER_AUTH_SECRET`, Resend, OAuth or onboard DB |
| Shared `BETTER_AUTH_SECRET` reused for storage signing; SOC dev session secret in production | HKDF-derived `STORAGE_SIGNING_SECRET` and `SOC_SESSION_SECRET`; SOC refuses the dev default under `NODE_ENV=production` |
| APIs bound to `0.0.0.0` | Both children receive `HOST=127.0.0.1` and bind to it (default unchanged for Docker/local) |

## Fixed — hardening (MEDIUM / LOW)

- **Admin:** `@FreshSession()` on the whole admin controller; audit rows for `users.export` and `user.view`;
  `admin_audit_log` append-only for the app role (migration 0005); cookie cache 300 s → 60 s; internal identity
  endpoint uses `disableCookieCache` so revocations propagate immediately.
- **Auth:** per-email OTP issuance cap (5/hour, DB-backed in `rate_limits`) on send-verification and
  password-reset; `encryptOAuthTokens: true`; `/signout` no longer signs out on a bare GET.
- **Prototype-key bugs:** `__proto__`/`constructor` as `requestId`, `findingId`, `objectiveId`, principal or bucket
  names now hit the normal not-found path (labs, Red Team, SOC) instead of a silent replay or a 500.
- **SOC caps:** one active demo per user; ≤ 3 open attempts; ≤ 3 SSE streams per user; stream ended and interval
  cleared when a case closes; `beats` entries deleted on close and swept hourly; idle/closed streams swept every
  5 min; SIGTERM handler registered only when standalone.
- **Red Team standalone:** hard-coded `APP_SECRET` removed (random per boot in dev with a warning; ≥ 32-char env
  value required in production). Red Team mount now receives `internalToken` so its progress reaches the profile.
- **InterviewPrep:** malformed list cursors → 400 `VALIDATION_FAILED` (was 500); body-parser errors → 400/413
  without Sentry noise; pg-boss job expiry computed above worst-case LLM time, scoring retries capped at 2,
  `retryReport` capped at 3; ≤ 3 SSE streams per user with identity re-check every 30 s; learner first name
  stripped from every prompt window.
- **Browser labs:** ThreatWall and DevSecOps localStorage namespaced per platform user (same pattern as
  AI-Security) with a one-time legacy migration; ThreatWall admin/user passwords hashed with SHA-256
  (`crypto.subtle`, legacy FNV verified then re-hashed) and password fields marked so password managers don't
  offer the learner's real ThreatReady password.
- **DevSecOps learner JS:** `new Function` on the platform origin replaced by a sandboxed iframe
  (`sandbox="allow-scripts"`, opaque origin, per-run nonce, source/origin checks) running the code in a Worker with
  a 2 s timeout. The `'unsafe-eval'` CSP carve-out for `/labs/devsecops` is removed; the lab's own `sandbox.html`
  gets a dedicated CSP. Verified under the gateway CSP: pipeline, tests, objectives and error messages unchanged.
- **Gateway/launcher:** HSTS `includeSubDomains`; `/healthz` returns 503 once a child has been down > 60 s after
  having been ready (crash loops now visible to Render); `/robots.txt` and `/.well-known/security.txt` served as
  files; role password set via PostgreSQL `format(%L)` instead of string interpolation.
- **Repo/CI:** CI workflow moved to `/.github/workflows/ci.yml` (fixed paths, `INTERNAL_API_TOKEN`, failing wait
  loop, `permissions: contents: read`); stale blueprints `soc/render.yaml`, `threatready-lab-001/render.yaml`,
  `AI-Security/render.yaml` deleted; `.gitleaks.toml` allowlists the fake training keys; source maps disabled for
  onboard and InterviewPrep web; `AI-Security/server.js` refuses to start in production and sends security
  headers; landing demo fetch uses `credentials: 'omit'` and `no-referrer`.

## Verified

- Per app: `npm ci` + typecheck + tests — threatready-lab-001 53/53, attack-reasoning 21/21, red_team_lab 23/23,
  soc 98/98 (3 pre-existing skips), ThreatWall 46/46 + Playwright 30/30 tasks, AI-Security 197/197, InterviewPrep
  api 104/104 unit + reasoning e2e 17/17 (other e2e failures byte-identical to baseline), onboard typecheck +
  routes 11/11 + e2e 21/21 against PostgreSQL 16 with all migrations applied.
- `deploy/build.sh` (the exact Render build) runs to completion on the patched tree.
- Gateway harness: internal paths 404 with every edge header, 200 bare on loopback; client-IP precedence and
  overwrite; hop-by-hop headers absent upstream; healthz/readyz/degraded.

## Not changed in this patch (needs a product or business decision)

- **Legal pages** (`Landing_Page-main/privacy.html`, `security.html`, `dpa.html`, `terms.html`) still claim AWS
  Mumbai residency, staff MFA, backups, 30-day deletion, age verification and self-service export, and still carry
  the `[Registered Office Address]` / `[To be appointed]` placeholders. Rewrite to the Render/Neon/Resend reality
  (or move to AWS) before public launch.
- **Staff TOTP** for the admin console (Better Auth `twoFactor` plugin + enrolment UI).
- **Durable storage:** uploads, PDFs and lab/SOC/Red Team state are still in `/tmp` on Render free.
- **Dependency upgrades:** AI-Security `jspdf` 2.x / `express` 4.21 and the dev-only advisories were left as-is
  so lockfiles stay valid; upgrade in a separate change with `npm install`.
- **`autoDeploy: true`** in `render.yaml` and action tags (`@v4`) not pinned to SHAs.
- **Landing demo backend** (`threatready-db.onrender.com`) is outside this repo.
- Browser-graded labs (ThreatWall, DevSecOps, AI-Security) still grade client-side; none post scores, so the
  impact is the learner's own screen only.
