# ThreatReady — auth + product landing (V1.0 slice)

Two pages, backed by a real API:

1. **Auth page** (`/`): username/password sign-in, registration with email OTP, forgot username, forgot password (OTP), Google and GitHub, and a free trial with no sign-up.
2. **Product page** (`/app`): the three feature cards (Interview Prep, Simulations, Attack Reasoning Lab). Each card opens a module route (`/app/interview`, `/app/simulations`, `/app/reasoning`) that runs the entitlement check.

Stack follows the Architecture Decision Document: Vite React SPA, NestJS modular monolith, Better Auth 1.7.7 in-process, Drizzle on PostgreSQL 16 with RLS, SES behind `EmailPort`, Turnstile.

```
apps/api            NestJS API (+ Better Auth mounted at /api/auth)
apps/web            Vite React SPA
packages/contracts  Zod schemas, credential policy, plan limits — shared by both
infra/db/init.sql   Roles: owner (migrations), app (API, no BYPASSRLS), worker
```

## Run locally

Requirements: **Node 22.9+**. That's all: pnpm is installed if missing, and PostgreSQL 16 is bundled (no Docker or installer needed). If you already run PostgreSQL on :5432, or Docker Desktop is running, those are used instead.

Extract the whole zip, open the inner `threatready` folder (the one with `pnpm-workspace.yaml`), and:

- **Windows:** double-click `start.cmd`
- **macOS/Linux:** `./start.sh`

The launcher checks Node, confirms no project files are missing, installs, creates `apps/api/.env` with a generated secret, starts PostgreSQL (on Windows the bundled one opens in its own window titled "ThreatReady database": keep it open), migrates, then runs `pnpm dev` and opens **http://localhost:5173**.

The same steps by hand, from the `threatready` folder:

```bash
pnpm bootstrap      # verify files, install, create .env + secret, build
pnpm db:local       # bundled PostgreSQL 16; keep this terminal open (or: pnpm db:up for Docker)
pnpm db:migrate
pnpm dev            # in a second terminal: pre-flight check, then API :3000 + web :5173
```

Things that look like bugs but aren't:

- `pnpm setup` is a built-in pnpm command, not this project's setup. Use `pnpm bootstrap`.
- `http://localhost:3000` is the API, not the app. In dev it redirects to :5173.
- "Index of threatready/" means a static file server (Live Server, `npx serve`) is serving the folder on :3000. Stop it; `pnpm doctor` names the culprit.

The bundled database keeps its data in `.local/postgres` (git-ignored). To start over, stop it and delete that folder.

With `EMAIL_DRIVER=log`, OTP and username emails print in the `pnpm dev` terminal and appear at http://localhost:5173/api/dev/mailbox. Google and GitHub buttons stay disabled until their keys are in `apps/api/.env`.

## Tests

```bash
pnpm --filter @threatready/api test:routes    # every route is @Public or declares a permission
pnpm test:e2e                                 # needs the API running with RATE_LIMIT_MULTIPLIER=10
```

The e2e suite (21 tests, real PostgreSQL, no mocks) covers:

- **Registration:** sign-up → OTP → verify → login; wrong, reused and locked-out OTPs are rejected.
- **No account enumeration:** duplicate-email sign-up, password reset and forgot-username give identical responses for registered and unknown emails.
- **Password reset:** OTP is single-use, other sessions are revoked, the old password stops working.
- **Rate limits:** login and trial sign-in are limited per IP.
- **Trial caps:** enforced per feature, and 6 parallel launches cannot overspend a cap of 2.
- **Trial → account:** registering from a trial session deletes the trial user.
- **Ownership:** another user's resource returns 404.
- **RLS backstop:** tested directly as the app DB role. No `app.user_id` set → zero rows; cross-user insert rejected; delete denied.
- **Turnstile:** a second API instance runs against a siteverify stub; missing, bad and good tokens each behave correctly.

CI (`.github/workflows/ci.yml`) runs typecheck, build, the route check, migrations and the e2e suite on every PR.

## Security decisions

| Requirement | Implementation |
|---|---|
| Password hashing | Better Auth scrypt; 12–128 chars (`packages/contracts`) |
| OTPs | 6 digits, 10-min expiry, 3 attempts then void, stored hashed, single-use, rate-limited per path and IP |
| Login errors | Unknown user and wrong password return the same 401; unknown users still run a hash (timing) |
| Forgot username | Always `202 {accepted:true}`. The username is only ever emailed, never returned. Per-IP throttle plus 3/hour per email |
| Duplicate sign-up | Generic success; the real owner gets an "you already have an account" email |
| Email sends | Fire-and-forget, so response time doesn't reveal whether an account exists |
| OAuth linking | Better Auth 1.7.7 links only when the IdP asserts a verified email **and** the local account is verified. This closes the pre-registration hijack, so the ADD's custom "delete password on link" rule isn't needed |
| Unused auth paths | Disabled: email sign-in, OTP sign-in, link-based reset, email change, profile update |
| Sessions | httpOnly, SameSite=Lax, `tr` prefix (`__Secure-` on https), 7-day sliding expiry, 5-min signed cookie cache (revocation lag as documented in ADD L6) |
| Authorization | Global default-deny guard: identity → tenant (personal org) → role → permission. Entitlement in the service, ownership via scoped queries + RLS |
| Free trial | Better Auth anonymous session + Turnstile + 3/hour/IP. Caps: 1 interview, 2 simulations, 1 reasoning session |
| Abuse | Turnstile on sign-up, login, trial, OTP resend, password reset, forgot username. Config refuses to boot in production without it |
| Headers | `apps/web/public/_headers`: strict CSP (self + Turnstile only), HSTS, frame-ancestors none |

## Deployment notes

- **Same origin (recommended):** route `app.threatready.io/api/*` to the ALB in Cloudflare. Cookies stay host-only and there's no CORS. Set `BETTER_AUTH_URL` and `WEB_ORIGIN` to `https://app.threatready.io`.
- **Split host (`api.threatready.io`):** set `VITE_API_ORIGIN` at build time. The API turns on credentialed CORS for `WEB_ORIGIN` automatically. Add the `api.` host to the CSP `connect-src`.
- **Client IP:** `CLIENT_IP_HEADER=cf-connecting-ip` behind Cloudflare → ALB. This is safe only because the ALB accepts Cloudflare ranges alone (HLD-4).
- **OAuth redirect URIs:** `https://<BETTER_AUTH_URL host>/api/auth/callback/google` and `.../callback/github`.
- **SES:** credentials come from the ECS task role. Verify the sending domain in ap-south-1 and leave the SES sandbox before launch.
- **Migrations:** one-off task `node dist/db/migrate.js` with `DATABASE_MIGRATION_URL` (owner role). The API uses `DATABASE_URL` (app role).
- **Image:** `docker build -f apps/api/Dockerfile .`

## Not done yet

- **Plan limits are placeholders** (`packages/contracts`, `PLAN_LIMITS`). Set them when pricing is decided; the SPA copy follows automatically.
- **Module workspaces:** `/app/:feature` records the session and shows a placeholder. Interview, labs and reasoning mount there per the roadmap.
- **Worker role (pg-boss):** emails are sent in-process today. Planned jobs: move sends to the queue, purge abandoned trial users, and carry trial history into a new account (currently the trial user and its launches are deleted on sign-up).
- **Per-email throttle on forgot-username** is in-process. Fine for one API task; move it to the DB or Valkey when a second task runs.
- **Staff TOTP** (ADD L6): no staff routes exist yet. Add the 2FA plugin and a guard check when they do.
