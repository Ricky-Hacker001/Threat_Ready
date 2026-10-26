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
labs, and Attack Reasoning). A lab emulator crash or memory leak is contained to the labs child: sign-in
and the APIs keep running, and the public port stays up while the launcher restarts it. This is crash
and memory containment, not a security boundary against code running in a child: every process runs
as the same user, so such code can read the start-up environment of the launcher and of the other
children (see "Limits of the isolation" below).

At start the launcher binds the port, restores the labs' saved state (below) and only then starts the
labs child, whose stores read it. It then runs each app's migrations under a PostgreSQL advisory lock,
so an overlapping deploy or a second instance waits instead of migrating at the same time, and starts
the two APIs. `/healthz` answers 503 while that runs and, on a deploy, until every child has started
(see "Health check"), so a failed migration or a child that never starts leaves the deploy unhealthy
and Render keeps the old version running. On `SIGTERM` (deploy, restart, sleep) it stops taking
requests and stops the children; the labs child writes its last lab changes on its way out, and once it
has exited the launcher saves the labs' state, all within Render's 30-second shutdown delay.

### Memory budget (512 MB instance)

| Process | `--max-old-space-size` | Why |
|---|---|---|
| gateway (`render.yaml` startCommand) | 48 MB | Proxies, serves static files and runs the lab-state mirror; nothing of the labs runs here any more (was 96). The mirror parses a lab file before uploading it only up to 1 MB and checks bigger ones without parsing, so a large lab file cannot exhaust this heap |
| onboard API | 110 MB | NestJS + Better Auth + pg pool; measured ~60–70 MB heap at rest (was 120) |
| InterviewPrep API + worker | 180 MB | Largest app: pg-boss worker, PDF/report generation, LLM calls in flight (was 200) |
| labs child | 150 MB | Lab emulators, SOC event store, Red Team store and Attack Reasoning catalogue (previously inside the gateway's 96) |

Sum of old-space caps: 488 MB. Caps are ceilings, not reservations: at rest the four processes use
roughly 375–400 MB PSS in total (code, buffers and `--max-semi-space-size=2` semi-spaces come on top
of each heap). If a child hits its cap it exits with an out-of-memory error, the launcher logs a
`child_exit` line and restarts it with back-off; the other children and the gateway are unaffected.
Tune a cap only together with the others so the sum stays under ~490 MB.

### Internal tokens

`INTERNAL_API_TOKEN` is the one generated secret, but no child receives it in its environment. The
launcher derives a token **per caller → callee pair** from it with HKDF-SHA256 (`deploy/launcher-lib.mjs`,
`internalTokenEnv`) and hands each child only what it needs:

| Child | Accepts (`INTERNAL_TOKENS_ACCEPT`) | Presents |
|---|---|---|
| onboard | labs→onboard, ar→onboard, interview→onboard, redteam→onboard | `INTERNAL_TOKEN_TO_INTERVIEW`, `_LABS`, `_AR` |
| InterviewPrep | onboard→interview, ar→interview on `/internal/v1/reasoning/*`; onboard→interview alone (`INTERNAL_TOKEN_FROM_ONBOARD`) on the summary, AI usage and account erasure routes | `INTERNAL_TOKEN_TO_ONBOARD` |
| labs child | onboard→labs (Lab Simulations with its SOC and Red Team summaries), onboard→ar (Attack Reasoning) | `LABS_`/`AR_INTERNAL_TOKEN_TO_ONBOARD`, `AR_INTERNAL_TOKEN_TO_INTERVIEW` |

A token that opens one app's `/internal/v1` opens no other. Within InterviewPrep, Attack Reasoning's
token (held by the labs child) opens only the reasoning routes it reads; account erasure accepts
onboard's token alone, and InterviewPrep refuses to boot in production without
`INTERNAL_TOKEN_FROM_ONBOARD` (unless legacy acceptance is on). Inside the labs child the Lab Simulations
gate and the hosted Red Team lab share one identity resolver (labs→onboard): one onboard lookup per
request and one set of per-client limits. The SOC and Red Team summaries reach the profile through the
labs summary (in process, with a token only that process knows). `INTERNAL_TOKEN_LEGACY_ACCEPT=true`
makes every child accept the raw token again (and passes it to them); the default is `false` in
production and `true` elsewhere, so a local setup configured with one shared token keeps working. The
onboard child's `INTERNAL_API_TOKEN` is a filler value in production (its config requires one); it
opens nothing.

#### Limits of the isolation

The token split above limits what each child is *given*, not what it can *read*. The launcher and all
three children run as one user in one container, and Linux lets a process read
`/proc/<pid>/environ` of any other process of the same user that is dumpable, which Node processes
are by default (Yama `ptrace_scope=1` does not prevent it; it only restricts attaching). Code
execution in any child, for example through a lab emulator bug in the labs child, can therefore read
the launcher's start-up environment (the raw `INTERNAL_API_TOKEN` and so every derived token,
`BETTER_AUTH_SECRET`, the database owner URLs, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`) and the other
children's environments. Process isolation still contains crashes and memory; the per-caller tokens
(and InterviewPrep accepting only onboard's token for account erasure) are defence in depth, not a
barrier against a compromised child. To make it one, the owner can choose one of:

- run the children under a separate user (needs a runtime that allows changing user, not Render's
  native Node runtime as configured here);
- make the launcher non-dumpable (`prctl(PR_SET_DUMPABLE, 0)` through a small native helper), so its
  `/proc/<pid>/environ` becomes readable by root only; the children would then still see each other's;
- move the labs into their own Render service that holds only the labs' tokens (a separate origin, so
  it needs the custom domain for the shared sign-in cookie).

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
   | `SENTRY_DSN` | optional; a Sentry project DSN for error tracking (leave empty to run without) |
   | `INTERVIEW_DATA_STORAGE_LOCATION` | optional; where interview data is stored as the AI consent notice states it (e.g. `Singapore`); a legal decision. Empty: the notice names no location |
   | `TRIAL_ENABLED` | optional; `true` offers guest sessions without an account (default off; an owner decision) |

   `BETTER_AUTH_SECRET`, `INTERNAL_API_TOKEN` and `ONBOARD_APP_DB_PASSWORD` are generated by Render.
   Each child process receives only the variables it needs (the owner database URL, the other app's
   database and keys never reach it); storage-link and SOC session keys are derived from
   `BETTER_AUTH_SECRET` per purpose.

   **Internal routes.** `/api/internal/*`, `/labs/internal/*`, `/ar/internal/*` (and `/internal/` under
   any lab) are server-to-server only. The gateway answers 404 unless the peer is loopback **and** the
   request carries no edge header (`x-forwarded-for`, `cf-connecting-ip`, `rndr-id`, …); behind Render
   every peer is loopback, so the internal tokens are the control that matters: per caller and
   callee, derived from `INTERNAL_API_TOKEN` (see "Internal tokens"). Never reuse it elsewhere.
3. Apply. The first build takes several minutes. When it's live, open the service URL
   (`https://threatready-xxxx.onrender.com`).
4. Social sign-in (optional): in Google Cloud and GitHub, set the redirect URIs to
   `https://<your service URL>/api/auth/callback/google` and `.../api/auth/callback/github`.
5. **Deploy only green commits.** `render.yaml` keeps `autoDeploy: true`, which deploys every push even
   when CI failed. In the service → **Settings → Build & Deploy**, turn on **Wait for CI** so Render
   deploys only after the GitHub checks pass. (Alternative: set `autoDeploy: false` in `render.yaml`
   and deploy from the dashboard or a deploy hook at the end of the CI workflow.)
6. `LLM_MODEL_SMALL` is declared in `render.yaml` with InterviewPrep's current default
   (`claude-haiku-4-5`); change it there when the model id changes. InterviewPrep refuses to start
   in production without it, and the launcher stops the boot first with
   `Missing environment variable LLM_MODEL_SMALL`. A service created before it was declared does not
   have it until the Blueprint is synced: add it in Render → Environment before deploying (the old
   version keeps running if a deploy stops on it).

## Free-tier behaviour to expect

- **Sleeps after 15 minutes without traffic.** The first visit after that takes about a minute.
- **The instance disk is wiped on every restart, sleep and deploy.** Lab Simulations, SOC simulation
  and Red Team lab progress is kept anyway: the launcher mirrors those JSON files to the InterviewPrep
  database (schema `threatready_ops`, table `lab_state_files`, created on first use) every 30 seconds
  when something changed and on shutdown, and restores them before the labs child starts. On
  `SIGTERM` the labs child writes its pending changes and exits first, then the last upload runs. A
  crash (no `SIGTERM`) can lose the last 30 seconds. An instance uploads only once it serves (`/healthz` 200),
  so a deploy that never goes live leaves the saved copies alone. During a deploy the old and new
  instances overlap for a short time and the **newest instance wins**: what the old one saves after the
  new one has taken over is kept as a `<file>@conflict-<old instance start>-<id>` row (one per instance,
  newest three per file), never restored, and logged; nothing is merged. A restored file that a lab
  store refuses (it moves it aside as `<file>.corrupt*` and starts empty) is first copied to
  `<file>@rejected-<time>-<id>` and logged as an ERROR, for recovery by hand. Conflict and rejected copies
  are deleted after 30 days. If the database cannot be read at start, the labs start empty and that
  instance uploads nothing (the saved copy is never overwritten); restart once Neon is reachable.
  The labs and SOC tell learners where their records are kept from what the mirror reports
  (`TR_STATE_DURABLE`, set by the launcher only: in the labs child's environment, and every change
  over its IPC channel): "saved to your ThreatReady account" while it saves,
  "kept on the ThreatReady lab server" when it is off, could not read the saved state, holds a file
  back (over the size cap, refused, owned by a newer instance) or two upload rounds in a row failed.
- **Uploaded resumes and report PDFs still live on the instance disk** and are lost on restart. The
  InterviewPrep code already supports object storage: set `STORAGE_DRIVER=s3`, `S3_BUCKET`,
  `AWS_REGION` and `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (AWS S3). Cloudflare R2 is cheaper but
  does not accept the presigned **POST** uploads InterviewPrep uses today, and InterviewPrep has no S3
  endpoint setting yet, so R2 needs a small InterviewPrep change (presigned PUT, an endpoint) first.
  Choosing and paying for one is an owner decision.
- The DevSecOps lab, ThreatReady Firewall and AI Security Lab keep progress in the learner's browser.
  Accounts, interviews, scores and AI usage are in Neon and are kept.
- **No captcha** unless you add both Cloudflare Turnstile keys (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`);
  sign-up then relies on rate limits and the launcher logs `WARNING: production is running without CAPTCHA`.
- `/healthz` turns 503 once any child (onboard, InterviewPrep or labs) has been down for over a minute
  after having been up (crash loop), or has not started five minutes after the migrations (stuck), so
  Render shows it and restarts the instance. While the labs child restarts, `/labs/*` and `/ar/*`
  answer `503 UPSTREAM_UNAVAILABLE` with `Retry-After` and the rest of the platform keeps working.
- **No error tracking** unless you set `SENTRY_DSN` (a Sentry project DSN; declared in `render.yaml`).
  It is forwarded to both APIs, and both report to it (onboard with a small built-in reporter). The
  labs, Attack Reasoning, SOC and Red Team run in the labs child and have no Sentry reporter; their
  errors are in the log with the request id. Without it the service still boots and the launcher logs
  a warning.
- **The 3D interviewer model isn't in the repo** (its licence forbids public download). Without it
  InterviewPrep shows Alex in 2D: an illustrated interviewer with lip sync, blinking and listening
  motion, which works in every browser. To use it, add it in Render → Environment →
  **Secret Files** with the name `interviewer.glb`; the launcher installs it at start. Never commit it.

## Settings

Everything below is optional; the defaults are right for this deployment. A malformed value stops
the boot with a message naming the variable (rather than being ignored).

| Variable | Default | What it does |
|---|---|---|
| `CLIENT_IP_SOURCE` | `xff-rightmost` | Where the visitor's IP comes from: `xff-rightmost` (the `X-Forwarded-For` entry `TRUSTED_PROXY_HOPS` places from the right), `cf-connecting-ip`, `true-client-ip` (only behind an edge that always overwrites that header) or `socket` (no proxy in front). |
| `TRUSTED_PROXY_HOPS` | `2` | Proxies that append to `X-Forwarded-For` in front of the service. See "Client IP" below. |
| `GATEWAY_MAX_BODY_BYTES` | `15728640` (15 MB) | Largest request body the gateway forwards to a child (the APIs and the labs child); bigger gets 413. `0` = no cap. |
| `GATEWAY_UPSTREAM_TIMEOUT_MS` | `180000` | A proxied request with no traffic for this long gets 504. Event streams are exempt. `0` = off. |
| `GATEWAY_PAGE_HOLD_MS` | `15000` | How long a lab page (`/labs/*`, `/ar/*` opened in the browser) waits for the labs child to come up after a wake or restart before it gets the "restarting" page. API calls never wait. `0` = answer at once. |
| `GATEWAY_BOOT_HEALTH` | `auto` | When `/healthz` says "starting" (503): `auto` = during the migrations, and on a release's first boot also until every child (both APIs and the labs child) has started; `wait` = always until every child has started; `migrations` = only during the migrations. See "Health check". |
| `STATE_MIRROR` | `on` | `off` stops saving lab state to PostgreSQL (progress is then lost on restart). |
| `STATE_MIRROR_INTERVAL_MS` | `30000` | How often changed lab files are uploaded. `0` = only on shutdown. |
| `STATE_MIRROR_MAX_BYTES` | `8388608` (8 MB) | A lab file whose stored (gzip) copy would be bigger than this is not uploaded (logged; lab JSON compresses about 10x, and a file over 4x this size uncompressed is not read). `0` = no cap. |
| `STATE_MIRROR_TABLE` | `threatready_ops.lab_state_files` | Where the copies live (in the InterviewPrep database). |
| `SENTRY_DSN` | — | Error tracking for the APIs (above). |
| `INTERNAL_TOKEN_LEGACY_ACCEPT` | `false` in production | `true` makes every child accept the raw `INTERNAL_API_TOKEN` next to its per-caller tokens (and hands it to them); the launcher logs a warning. For a migration window only. |
| `FORCE_ROLE_SYNC` | `false` | `true` re-issues `ALTER ROLE … PASSWORD` for onboard's app role on this boot even when the stored digest says the password is unchanged (e.g. after restoring the database). |
| `LABS_INTERNAL_PORT`, `ONBOARD_INTERNAL_PORT`, `INTERVIEW_INTERNAL_PORT` | `4000`, `3200`, `3100` | Loopback ports of the children; must differ from each other and from `PORT`. |

**Each app's own settings** reach it by name: the launcher forwards an app's tunables by prefix
(`deploy/child-env.mjs`) and logs the forwarded names (never values) at start. Onboard gets
`TRIAL_*`, `AUTH_*`, `SIGNIN_*`, `OTP_*`, `ACTIVITY_*`, `RETENTION_*`, `TURNSTILE_*`, `SENTRY_*`,
`RATE_LIMIT_*` and its listed keys (email, OAuth, `ADMIN_EMAILS`, `COOKIE_DOMAIN`, …). InterviewPrep
(which also hosts the Attack Reasoning engine) gets `AI_*`, `LLM_*`, `REASONING_*`, `INTERVIEW_*`,
`RATE_LIMIT_*` (e.g. `RATE_LIMIT_SCALE`), `REPORT_*`, `STORAGE_*`, `S3_*`, `AWS_*`, `SES_*`,
`SENTRY_*`, `DATA_*`, `IDENTITY_*`, `WORKER_*`, `DATABASE_POOL_*` and `ANTHROPIC_API_KEY`. Neither
app ever receives the other's secrets or the launcher's own (owner database URLs, the role password,
`BETTER_AUTH_SECRET` for InterviewPrep). The labs child gets `LABS_*` (e.g. `LABS_RATE_PER_MIN`,
`LABS_MAX_RUNS_PER_LAB`, `LABS_IDENTITY_MAX_IN_FLIGHT`), `AR_*`, `REDTEAM_*`, `SOC_*`,
`IDENTITY_CACHE_SECONDS` and `DAILY_WIPE`, never an API's key or database; SOC's test switches
(`SOC_SIM_TEST`, `SOC_SIM_FAST`) and its standalone summary token (`SOC_INTERNAL_TOKEN`) are never
forwarded (logged if set). Values the launcher decides (URLs, database roles, production mode, the LLM
driver, the internal tokens, the lab state files and `TR_STATE_DURABLE`) cannot be overridden this
way. Guest ("trial") sessions are off unless
`TRIAL_ENABLED=true`. Onboard's test hooks `RATE_LIMIT_MULTIPLIER` and `TURNSTILE_VERIFY_URL` are never
forwarded (onboard refuses to boot in production with them); the launcher logs a warning if one is set.

### Health check

Render polls `/healthz` (`healthCheckPath` in `render.yaml`). A new deploy goes live only once it
answers 200, and Render cancels it, keeping the old instance, if that does not happen within 15
minutes. A running instance that fails the check for 60 seconds is restarted
([Render health checks](https://render.com/docs/health-checks)). The launcher binds the port at once
(the web pages answer meanwhile, the labs once the labs child is up) and reports
`{"ok":false,"phase":"starting"}` with 503:

- **while the lab state is restored and the migrations run**, every boot. A failed migration exits, so
  a deploy with a broken migration is never marked live;
- **on a release's first boot, until every child (both APIs and the labs child) has answered once.** A
  release is the commit plus every setting the children receive; after a complete boot the launcher
  notes it (an HMAC fingerprint, never the values) in `threatready_ops.launcher_boots` in the
  InterviewPrep database. A deploy whose API or labs child crashes at start (for example a setting it
  rejects) is therefore not marked live either.

A restart or a wake from sleep of a release that has booted before is not held at 503 after the
migrations: the APIs start behind a 200 (`/api` and `/v1` answer 503 `STARTING` with `Retry-After`
meanwhile, `/labs` and `/ar` too until the labs child is up), so a slow wake on the free instance
cannot run into the 60-second restart. If Render restarts a deploy of working code before every child
is up (the log shows the launcher starting over with no error), set `GATEWAY_BOOT_HEALTH=migrations`.
The lab-state mirror starts uploading only once the boot is complete and the labs child's stores have
read the restored files.

### Client IP

Rate limits on sign-in, sign-up and codes key on the visitor's IP, so the gateway must not take it
from a header the visitor can write. On Render ([DDoS protection](https://render.com/docs/ddos-protection),
[how Render handles DDoS](https://render.com/articles/how-render-handles-ddos-attacks)) every request
passes Cloudflare's edge and then Render's proxy. Both **append** to `X-Forwarded-For` and keep
whatever the visitor sent, so the left-most entries are the visitor's own text:

```
X-Forwarded-For: <anything the visitor wrote>, <visitor IP as Cloudflare saw it>, <Cloudflare edge IP>
```

The default takes the entry 2 from the right. Some reports see one more internal hop on the free
plan; if that applies, every visitor would appear as a Cloudflare address. The gateway checks this
itself without logging any address: after the first request carrying both headers (and again after
50) it logs where Cloudflare's `CF-Connecting-IP` sits in `X-Forwarded-For`, for example
`[gateway] client IP: … CF-Connecting-IP position in X-Forwarded-For over 50 request(s): 2 from the right: 50`.
If it reports another position, the line ends in a warning naming the value to set
(`TRUSTED_PROXY_HOPS=3`), or set `CLIENT_IP_SOURCE=cf-connecting-ip` (Cloudflare overwrites that
header, and Render routes all traffic through Cloudflare). A `CF-Connecting-IP` or `True-Client-IP`
the visitor sends is never used otherwise. The APIs only read the gateway's own
`x-threatready-client-ip`, which it writes over anything the visitor sent (it also replaces
`X-Forwarded-For` with that one address and drops the other client-address headers). The labs child
listens on loopback only and turns that header into its `req.ip` for every lab (it trusts its loopback
peer, the gateway; a request without a valid stamp is keyed on the peer address).

### Request handling at the gateway

Proxied requests (`/api/*`, `/v1/*`, and `/labs/*`, `/ar/*` to the labs child) are re-framed by the
gateway: a body is forwarded with exactly the framing it arrived with, so a `GET`/`DELETE` body can
never turn into a second request on the loopback connection, and a request with both
`Transfer-Encoding` and `Content-Length` (or any coding but `chunked`) gets 400. Bodies over the cap
get 413 before the child sees a complete request, and compressed request bodies (`Content-Encoding`
other than `identity`) get 415. A request idle for `GATEWAY_UPSTREAM_TIMEOUT_MS` gets 504 (event
streams exempt); a child that is restarting answers 503 with `Retry-After`. Every request gets a fresh
`x-request-id` (a client-sent one is replaced), which the children log and every gateway error echoes.

The gateway's own errors keep each client's format: `/api` and `/v1` get the APIs' envelope
`{ "error": { "code", "message", "retryable", "requestId" } }`; under `/labs` and `/ar` the lab clients
show `error` or `message` as text, so there both carry the message (for example "Lab Simulations is
briefly unavailable. Try again in 5 seconds.") with `code`, `retryable` and `requestId` beside them. A
lab page opened in the browser (address bar, reload, link) while the labs child starts or restarts
first waits up to `GATEWAY_PAGE_HOLD_MS` for it, as on the single process before, where the port
opened only once the labs had loaded. If the child is still not answering it gets a small page in the
platform's style ("Lab Simulations is restarting. This page reloads in 5 seconds.", with Retry), never
the JSON as the document.

The security headers (`deploy/gateway.mjs` `CSP_DIRECTIVES`, the one source the onboard `_headers`
file is generated from by `tools/gen-headers.mjs`) include `connect-src 'self' blob:` (blob: is for
the 3D interviewer's textures, which three.js loads with `fetch(blob:)`). The labs child sets the same
headers itself and its hosted labs adjust the CSP for their own pages only: `frame-src 'self'` on the
DevSecOps and Red Team pages, the DevSecOps `sandbox.html` policy and the Red Team
`target-frame.html` sandbox policy. The gateway keeps a child's CSP for those responses.

## Troubleshooting

- Logs: Render → the service → Logs. Lines start with `[launcher]` for setup and `[labs]` for the labs
  child. A child exit is one JSON line: `{"event":"child_exit","name":"labs","code":…,"signal":…,"uptimeMs":…,"exits":…}`.
- `/readyz` shows each child (`onboard`, `interview`, `labs`), its status (`ready` / `starting` /
  `down`), exits since it was last ready and its last `heapUsed` sample (bytes; sampled every 30 s
  from onboard's loopback-only `/__health`, the labs child's `/`; InterviewPrep's `/` does not report
  one, so it reads `null`).
- Every response carries an `x-request-id` (always generated by the gateway; a client-sent one is
  replaced); gateway-originated error JSON echoes it as `requestId`, and the children receive and log
  it. Quote it when reporting a problem.
- `app role password unchanged; ALTER ROLE skipped` is normal: the launcher keeps a digest of the app
  role's password in `threatready_launcher_state` (owner-only table in the onboard database) and
  only re-issues `ALTER ROLE … PASSWORD` when `ONBOARD_APP_DB_PASSWORD` changed. Set
  `FORCE_ROLE_SYNC=true` for one deploy to force it (e.g. after restoring the database from a backup).
- `Missing environment variable …`: fill it in Render → Environment, then redeploy.
- `state mirror: ERROR could not read saved lab state`: Neon was unreachable at start. Lab progress
  saved earlier is safe in the database; restart the service once Neon answers.
- `another instance is migrating this database; waiting`: an overlapping deploy holds the migration
  lock; the launcher continues when it is released (it gives up after 10 minutes).
- `state mirror: ERROR the lab store did not accept the restored …`: a lab's saved file did not have
  the shape its store expects. The store started empty; the old file is in the
  `threatready_ops.lab_state_files` row named in the message (gzip JSON in `content`) for 30 days.
- A deploy stays "in progress" and `/healthz` says `starting`: a child did not start; its error is in
  the log above (`Missing environment variable LLM_MODEL_SMALL`: set it, see "Deploy"). Render keeps
  the previous version live and cancels the deploy after 15 minutes.
- Local development without the launcher: `createGateway({ labsApp, arApp })` still mounts Labs and
  Attack Reasoning in-process (see `deploy/gateway.mjs`); the labs child is only used by `start.mjs`.
- Tests: `cd deploy && npm test` (gateway with stub children, launcher helpers, child environments;
  the state-mirror suite needs `STATE_MIRROR_TEST_DATABASE_URL` pointing at a disposable PostgreSQL
  database; the labs child suites run once `npm run bundle` has produced `deploy/dist`, and test SOC
  and Red Team when their client builds exist, as after `deploy/build.sh`).
