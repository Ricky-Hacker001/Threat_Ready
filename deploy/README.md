# Deploying ThreatReady on Render (free tier)

The whole platform runs as **one free Render web service** at one URL:

| Path | App |
|---|---|
| `/` | onboard: sign-in, home, profile, admin console |
| `/interview-prep/` | InterviewPrep |
| `/labs/` | Lab Simulations: tracks, and the AWS lab at `/labs/TR-CLOUD-001` |
| `/labs/soc/`, `/labs/devsecops/`, `/labs/threatwall/`, `/labs/redteam/`, `/labs/aisec/` | SOC simulation, DevSecOps lab, ThreatReady Firewall, Red Team web pentest lab, AI Security Lab (built from `soc/`, `DevSecOps-Simulation/`, `ThreatWall/`, `red_team_lab/web/`, `AI-Security/`; same sign-in) |
| `/ar/` | Attack Reasoning Lab |

One URL means one session cookie, so signing in once works in every app. (`onrender.com` is on the
Public Suffix List, so separate Render services could not share a login without a custom domain.)

How it runs (`deploy/start.mjs`): a gateway on Render's port serves the four web apps and proxies the
APIs to **three child processes** on loopback ports, each memory-capped to fit 512 MB and restarted on
crash: the onboard API, the InterviewPrep API (with its worker), and the **labs child**
(`deploy/labs-child.mjs`: Lab Simulations, the hosted SOC / Red Team / DevSecOps / Firewall / AI Security
labs, and Attack Reasoning). A lab emulator bug is contained to the labs child: it cannot read the
gateway's or another app's memory, and the public port stays up while the launcher restarts it.
Migrations run on every start (idempotent).

### Memory budget (512 MB instance)

| Process | `--max-old-space-size` | Why |
|---|---|---|
| gateway (`render.yaml` startCommand) | 48 MB | Proxies and serves static files only; nothing of the labs runs here any more (was 96) |
| onboard API | 110 MB | NestJS + Better Auth + pg pool; measured ~60–70 MB heap at rest (was 120) |
| InterviewPrep API + worker | 180 MB | Largest app: pg-boss worker, PDF/report generation, LLM calls in flight (was 200) |
| labs child | 150 MB | Lab emulators, SOC event store, Red Team store and Attack Reasoning catalogue (previously inside the gateway's 96) |

Sum of old-space caps: 488 MB. Caps are ceilings, not reservations: at rest the four processes use
roughly 375–400 MB PSS in total (code, buffers and `--max-semi-space-size=2` semi-spaces come on top
of each heap). If a child hits its cap it exits with an out-of-memory error, the launcher logs a
`child_exit` line and restarts it with back-off; the other children and the gateway are unaffected.
Tune a cap only together with the others so the sum stays under ~490 MB.

### Internal tokens

`INTERNAL_API_TOKEN` is the one generated secret, but no child receives it. The launcher derives a
token **per caller → callee pair** from it with HKDF-SHA256 (`deploy/launcher-lib.mjs`,
`internalTokenEnv`) and hands each child only what it needs:

| Child | Accepts (`INTERNAL_TOKENS_ACCEPT`) | Presents |
|---|---|---|
| onboard | labs→onboard, ar→onboard, interview→onboard, redteam→onboard | `INTERNAL_TOKEN_TO_INTERVIEW`, `_LABS`, `_AR` |
| InterviewPrep | onboard→interview, ar→interview | `INTERNAL_TOKEN_TO_ONBOARD` |
| labs child | onboard→labs (Lab Simulations, Red Team), onboard→ar (Attack Reasoning) | `LABS_`/`AR_`/`REDTEAM_INTERNAL_TOKEN_TO_ONBOARD`, `AR_INTERNAL_TOKEN_TO_INTERVIEW` |

A token that opens one app's `/internal/v1` opens no other. `INTERNAL_TOKEN_LEGACY_ACCEPT=true` makes
every child accept the raw token again (and passes it to them); the default is `false` in production
and `true` elsewhere, so a local setup configured with one shared token keeps working. The onboard
child's `INTERNAL_API_TOKEN` is a filler value in production (its config requires one); it opens
nothing.

## What you need (all free)

1. **Neon** (PostgreSQL) — https://neon.tech
   - Create a project (region: Singapore or closest to Render's).
   - Create **two databases** in it: `onboard` and `interviewprep` (Databases → New database).
   - For each, copy the connection string with **Pooled connection turned off** (the host must not
     contain `-pooler`). It looks like `postgresql://neondb_owner:…@ep-…neon.tech/onboard?sslmode=require`.
2. **Resend** (email for sign-up and password-reset codes) — https://resend.com
   - Create an API key.
   - Sender: until you verify a domain, Resend only delivers from `onboarding@resend.dev` to your own
     account's email. Verify a domain to email anyone.
3. **Anthropic API key** for the AI interviewer.
4. Optional: Google and GitHub OAuth apps (add the redirect URIs below after the first deploy).

## Deploy

1. Render dashboard → **New → Blueprint** → connect `Ricky-Hacker001/Threat_Ready` → it reads `render.yaml`.
2. Fill in the values it asks for:

   | Key | Value |
   |---|---|
   | `ONBOARD_DATABASE_URL` | Neon string for the `onboard` database |
   | `INTERVIEW_DATABASE_URL` | Neon string for the `interviewprep` database |
   | `RESEND_API_KEY` | Resend API key |
   | `EMAIL_FROM` | e.g. `ThreatReady <onboarding@resend.dev>` (or an address on your verified domain) |
   | `ANTHROPIC_API_KEY` | Anthropic key |
   | `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile (free) — set **both** to turn CAPTCHA on; with only one, CAPTCHA stays off and the launcher says which key is missing |
   | `GOOGLE_*`, `GITHUB_*` | optional; leave empty to hide those buttons |
   | `ADMIN_EMAILS` | your email, to get the admin console after you sign up and verify |

   `BETTER_AUTH_SECRET`, `INTERNAL_API_TOKEN` and `ONBOARD_APP_DB_PASSWORD` are generated by Render.
   Each child process receives only the variables it needs (the owner database URL, the other app's
   database and keys never reach it); storage-link and SOC session keys are derived from
   `BETTER_AUTH_SECRET` per purpose.

   **Internal routes.** `/api/internal/*`, `/labs/internal/*`, `/ar/internal/*` (and `/internal/` under
   any lab) are server-to-server only. The gateway answers 404 unless the peer is loopback **and** the
   request carries no edge header (`x-forwarded-for`, `cf-connecting-ip`, `rndr-id`, …); behind Render
   every peer is loopback, so `INTERNAL_API_TOKEN` is the control that matters. Never reuse it elsewhere.
3. Apply. The first build takes several minutes. When it's live, open the service URL
   (`https://threatready-xxxx.onrender.com`).
4. Social sign-in (optional): in Google Cloud and GitHub, set the redirect URIs to
   `https://<your service URL>/api/auth/callback/google` and `.../api/auth/callback/github`.
5. **Deploy only green commits.** `render.yaml` keeps `autoDeploy: true`, which deploys every push even
   when CI failed. In the service → **Settings → Build & Deploy**, turn on **Wait for CI** so Render
   deploys only after the GitHub checks pass. (Alternative: set `autoDeploy: false` in `render.yaml`
   and deploy from the dashboard or a deploy hook at the end of the CI workflow.)
6. `LLM_MODEL_SMALL` is declared in `render.yaml` with InterviewPrep's current default
   (`claude-haiku-4-5`); change it there when the model id changes.

## Free-tier behaviour to expect

- **Sleeps after 15 minutes without traffic.** The first visit after that takes about a minute.
- **Files don't survive a restart or sleep:** uploaded resumes, report PDFs, Lab Simulations, SOC
  simulation and Red Team lab progress (stored on the instance's disk). The DevSecOps lab and ThreatReady Firewall
  keep progress in the learner's browser. Accounts, interviews, scores and AI usage are in Neon and
  are kept.
- **No captcha** unless you add both Cloudflare Turnstile keys (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`);
  sign-up then relies on rate limits and the launcher logs `WARNING: production is running without CAPTCHA`.
- `/healthz` turns 503 once any child (onboard, InterviewPrep or labs) has been down for over a minute
  after having been up (crash loop), so Render shows it. While the labs child restarts, `/labs/*` and
  `/ar/*` answer `503 UPSTREAM_UNAVAILABLE` and the rest of the platform keeps working.
- **No Sentry** unless you set `SENTRY_DSN`.
- **The 3D interviewer model isn't in the repo** (its licence forbids public download). Without it
  InterviewPrep shows Alex in 2D: an illustrated interviewer with lip sync, blinking and listening
  motion, which works in every browser. To use it, add it in Render → Environment →
  **Secret Files** with the name `interviewer.glb`; the launcher installs it at start. Never commit it.

## Troubleshooting

- Logs: Render → the service → Logs. Lines start with `[launcher]` for setup and `[labs]` for the labs
  child. A child exit is one JSON line: `{"event":"child_exit","name":"labs","code":…,"signal":…,"uptimeMs":…,"exits":…}`.
- `/readyz` shows each child (`onboard`, `interview`, `labs`), its status (`ready` / `starting` /
  `down`), exits since it was last ready and its last `heapUsed` sample (bytes; sampled every 30 s
  from onboard's loopback-only `/__health`, the labs child's `/`; InterviewPrep's `/` does not report
  one, so it reads `null`).
- Every response carries an `x-request-id` (the gateway generates one when the client sends none);
  gateway-originated error JSON echoes it as `requestId`, and the children receive it. Quote it when
  reporting a problem.
- `app role password unchanged; ALTER ROLE skipped` is normal: the launcher keeps a digest of the app
  role's password in `threatready_launcher_state` (owner-only table in the onboard database) and
  only re-issues `ALTER ROLE … PASSWORD` when `ONBOARD_APP_DB_PASSWORD` changed. Set
  `FORCE_ROLE_SYNC=true` for one deploy to force it (e.g. after restoring the database from a backup).
- `Missing environment variable …`: fill it in Render → Environment, then redeploy.
- Local development without the launcher: `createGateway({ labsApp, arApp })` still mounts Labs and
  Attack Reasoning in-process (see `deploy/gateway.mjs`); the labs child is only used by `start.mjs`.
- Tests: `cd deploy && npm test` (gateway with stub children; the labs child suite runs once
  `npm run bundle` has produced `deploy/dist`).
