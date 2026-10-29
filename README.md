# ThreatReady platform

One sign-in, separate apps. Each app keeps its own overview, management, reports and status. The ThreatReady profile on onboard shows all of them together, and the admin console shows every user's activity, tokens and AI cost.

**Where it runs today:** one Render web service, **https://threatready.onrender.com**, with every app
under a path of that one origin (sign-in at `/`, sign-up at `/?mode=signup`; see `deploy/README.md`).
The marketing site `threatready.io` links there. The `*.threatready.io` subdomains in the table are the
**planned** multi-host layout (production checklist below); none of them exists in DNS yet, so never
link to them.

| Live path | Planned host | Project | What it is |
|---|---|---|---|
| `/` | `onboard.threatready.io` | `Threatready-landing-page-main/` | **Identity provider** and home: sign-in/up, OTP, Google/GitHub, the product page, the **unified profile** (`/app/profile`) and the **admin console** (`/app/admin`) |
| `/interview-prep/` (API `/v1/`) | `interviewprep.threatready.io` | `InterviewPrep/` | AI mock interviews: its own dashboard, history and reports |
| `/labs/` | `labs.threatready.io` | `threatready-lab-001/` | Lab **catalog** at `/labs/`, grouped into four tracks (Cloud Security, Blue Team, Red Team, Network Security); each track lists its labs at `/labs/tracks/<track>`. `TR-CLOUD-001` runs in this app at `/labs/TR-CLOUD-001`; the labs below are their own apps, served by this one behind the platform sign-in |
| `/labs/soc/` | `labs.threatready.io/labs/soc/` | `soc/` | On the main Labs page: SOC simulation (live log stream, L1 triage to L3 response), signed in as the ThreatReady user |
| `/labs/devsecops/` | `labs.threatready.io/labs/devsecops/` | `DevSecOps-Simulation/` | On the main Labs page: DevSecOps lab (scanners, fixes and a gated pipeline), runs in the browser |
| `/labs/aisec/` | `labs.threatready.io/labs/aisec/` | `AI-Security/` | On the main Labs page: AI Security Lab, 30 simulated AI/LLM attack-detect-fix-retest scenarios against AeroPay's assistant, runs in the browser |
| `/labs/threatwall/` | `labs.threatready.io/labs/threatwall/` | `ThreatWall/` | **Network Security**: ThreatReady Firewall, firewall administration from first cable to incident containment, runs in the browser |
| `/labs/redteam/` | `labs.threatready.io/labs/redteam/` | `red_team_lab/web/` | **Red Team**: web pentest lab TR-RED-001 (The Breach Files: AeroCart), recon to report with browser, proxy, repeater and terminal, signed in as the ThreatReady user |
| `/ar/` | `ar.threatready.io` | `attack-reasoning/` | Attack Reasoning Lab, **15 live domains** (Cloud Security, Identity & Access, AppSec, Network, SOC, IR & DFIR, DevSecOps, Kubernetes, Data, Threat Intel, Endpoint, Zero Trust, API, AI & LLM, GRC): **domain landing** at `/`, a domain's entry point at `/domains/<key>`, one AI-generated assessment at `/attempts/<id>` (architecture diagram, MCQ, written justification, three-stage evaluation, feedback), history and analytics at `/history`; hand-authored scenario briefs stay at `/scenarios/<id>`. The reasoning engine itself is the `reasoning` module of the InterviewPrep API (the ThreatReady monolith); this app proxies `/v1/*` to it. See `docs/ATTACK_REASONING.md` |
| — (GitHub Pages) | `threatready.io` | `Landing_Page-main/` | Public marketing site and the **source of the design system** every app follows |

## One design across every app

All apps follow threatready.io's design (`Landing_Page-main/assets/css/site.css`): navy surfaces, the violet `#6D5DFC` accent, Inter and JetBrains Mono, the ThreatReady logo, and a product marker per app (InterviewPrep amber, Labs teal, Attack Reasoning violet).

- `platform.css` is the shared shell: dark and light tokens, header with app switcher and theme toggle, footer, buttons, tags, cards. Identical copies live in onboard (`apps/web/src/styles/`), InterviewPrep (`apps/web/src/ui/`), Labs (`client/src/`), Attack Reasoning (`client/src/`) and the Red Team lab (`web/client/src/`); edit one, copy to the others.
- `theme-init.js` applies the theme before first paint and stores it in a `tr-theme` cookie on `threatready.io`, so dark/light follows the user across every subdomain.
- Onboard maps its own component tokens onto the platform tokens. InterviewPrep keeps its own sub-navigation layout with the brand palette and logo. The lab console deliberately keeps its AWS-console look; the Labs catalog uses the platform shell.

## How it fits together

```
browser ──► onboard.threatready.io ── Better Auth ──► session cookie, Domain=threatready.io
   │                                                     (shared by every subdomain)
   ├──► interviewprep.threatready.io/v1/*  ─┐
   └──► labs.threatready.io/api/*          ─┤ forward the Cookie header to
                                            ▼
               onboard  GET /api/internal/identity/session   (Bearer INTERNAL_API_TOKEN)
                        → { user: { id, name, email, isTrial, isAdmin, … } }

onboard /api/overview, /api/admin/*  ──►  each app  GET /internal/v1/users/:id/summary
                                                  GET /internal/v1/ai-usage?from&to[&userId]
```

- **Only a successful sign-in gets in.** A request without a session gets 401 and the SPA sends the browser to `onboard/?next=<this page>`. After sign-in (password, OTP verification or OAuth), onboard sends it straight back. `next` must be one of the registered app origins, and a bounce-back loop is detected and stopped. A no-account **trial** session stays on onboard: the apps answer `AUTH_ACCOUNT_REQUIRED` and the user is sent to create an account.
- **Sign-out** is one place: `onboard/signout?next=…` ends the shared session for every app.
- **Users are mirrored, not duplicated.** InterviewPrep upserts the onboard user (same id) into its own `users` table on first sight, because its data references `users(id)`. Labs records the id and name in its store. Onboard stays the authority.
- **Each app owns its data.** Onboard never reads another app's database. It calls the internal API, which returns the app's own summary (the same figures as the app's dashboard) and its own LLM ledger (`llm_call_log` in InterviewPrep, the ledger the AI budget is enforced on). If an app is down, its card shows "Unavailable" and the rest of the page still works.
- **Attack Reasoning runs in the monolith.** Following the ADD (L17b, module map), the reasoning engine is a module of the InterviewPrep API: same `LlmPort`, budget ledger, pg-boss worker, RLS and skill graph (`skill_evidence.source = 'reasoning'`). `attack-reasoning/` serves the SPA and proxies `/v1/*` to that API (`REASONING_API_URL`), so the browser only talks to its own origin. The API accepts the AR origin through `ALLOWED_APP_ORIGINS`. Onboard's `/ar/internal/*` calls are answered from the API's `/internal/v1/reasoning/*`, and the LLM ledger is split by feature prefix so AI cost is never double counted between the two cards.
- **Internal API**: token-checked in constant time, never routed through Cloudflare (onboard reaches the apps in-VPC). A browser session cannot call it.
- **Admin**: `users.role = 'admin'` (grant with `pnpm --filter @threatready/api admin:grant <email>`, revoke with `--revoke`) or a verified email in `ADMIN_EMAILS`. The admin console shows users, sign-ups, 7-day actives, and for any date range AI calls, input/output/cache tokens and cost per user, per app, per model and per feature. Each user's page shows their summary from every app and their active sessions. From a user's page an admin can **make another user admin or remove admin access** (`POST /api/admin/users/:id/role`): never your own role, never a trial or unverified account, never the last admin, and an `ADMIN_EMAILS` admin only by editing that setting; a removed admin is signed out everywhere and every change lands in `admin_audit_log` (migration 0004).

The contract (shapes of identity, summary and AI usage) lives in `Threatready-landing-page-main/packages/contracts/src/platform.ts`; InterviewPrep (`packages/contracts/src/platform.ts`) and Labs (`server/identity.ts`, `server/app.ts`) mirror it.

## Business accounts (organisations)

Since 28 Oct 2026 a company, team or institute can hold a **business account**: the sign-in page's "For your team" tab (or Profile → "Set up an organisation") creates an organisation whose admin invites people by email; invitees join with the invited address and use the product on the organisation's plan; org admins and managers get an **organisation console** at `/app/org` (people, invitations, progress, activity log) and the platform admin console gets an **Organisations** page where plans and seats are set by hand (billing comes later). Onboard migration `0012_business_accounts`; settings `ORG_*` in `Threatready-landing-page-main/apps/api/.env.example`; details in `docs/BUSINESS_ACCOUNTS.md`.

## Run everything locally

Node 24 or newer: every `package.json` sets `engines.node` to `>=24`, matching Render's `NODE_VERSION` and CI (pnpm refuses to install onboard on older Node).

| Service | Port | Command (from the project folder) |
|---|---|---|
| onboard API | 3200* | `apps/api`: `pnpm build && node --env-file=.env dist/main.js` |
| onboard web | 5173 | `apps/web`: `API_PROXY_TARGET=http://localhost:3200 pnpm dev` |
| InterviewPrep API + worker | 3100 | `npm run dev:api`, `npm run dev:worker` (with `.env` loaded) |
| InterviewPrep web | 5174 | `npm run dev:web` |
| Labs API | 4000 | `npx tsx server/index.ts` |
| Labs web | 5175 | `npx vite` |
| Attack Reasoning API | 4100 | `attack-reasoning/`: `npx tsx server/index.ts` (gateway; needs `REASONING_API_URL=http://localhost:3100`) |
| Attack Reasoning web | 5176 | `npx vite` (proxies `/v1` to :3100) |

\* onboard's default is 3000. This machine runs open-webui on 3000, so `apps/api/.env` sets `PORT=3200`, and InterviewPrep and Labs use `IDENTITY_URL=http://localhost:3200`.

1. `node Threatready-landing-page-main/scripts/init-env.mjs` creates onboard's `.env` with `BETTER_AUTH_SECRET` and `INTERNAL_API_TOKEN`. Copy the **same** `INTERNAL_API_TOKEN` into `InterviewPrep/.env`, `threatready-lab-001/.env` and `attack-reasoning/.env` (templates: `.env.example`).
2. Migrate onboard (`pnpm db:migrate`; adds `users.role`) and InterviewPrep (`node packages/db/dist/migrate.js` with `.env` loaded; adds migrations 0005 and 0006, the Attack Reasoning tables). Set `ALLOWED_APP_ORIGINS=http://localhost:5176` in `InterviewPrep/.env` and `REASONING_API_URL=http://localhost:3100` in `attack-reasoning/.env` (`REASONING_PREFETCH_ENABLED` controls background pre-generation of the next scenario). The InterviewPrep worker (`npm run dev:worker`) must run: scenario generation and evaluation are its jobs.
3. Open http://localhost:5173. Locally no `COOKIE_DOMAIN` is needed because localhost cookies ignore the port, so all three apps share the session.

## Production checklist (planned multi-host layout)

For the live single-origin Render service, follow `deploy/README.md` instead.

- Onboard: `COOKIE_DOMAIN=threatready.io`, `BETTER_AUTH_URL`/`WEB_ORIGIN=https://onboard.threatready.io`, `INTERVIEW_APP_URL`, `LABS_APP_URL`, `REASONING_APP_URL` (https), `*_INTERNAL_URL` pointing at the in-VPC services, `INTERNAL_API_TOKEN` from Parameter Store, OAuth redirect URIs on the onboard host.
- InterviewPrep: `APP_ORIGIN=https://interviewprep.threatready.io`, `ONBOARD_URL=https://onboard.threatready.io`, `IDENTITY_URL` = onboard in-VPC, same token. Web build: `VITE_ONBOARD_URL`.
- Labs: `APP_ORIGIN=https://labs.threatready.io`, `ONBOARD_URL`, `IDENTITY_URL`, same token. Web build: `VITE_ONBOARD_URL`.
- Attack Reasoning: `APP_ORIGIN=https://ar.threatready.io`, `ONBOARD_URL`, `IDENTITY_URL`, same token, `REASONING_API_URL` = the InterviewPrep API in-VPC. Web build: `VITE_ONBOARD_URL`. Onboard: `REASONING_STATUS=live`, `REASONING_INTERNAL_URL`. InterviewPrep: `ALLOWED_APP_ORIGINS=https://ar.threatready.io`.
- Cloudflare: route `/api/*` (onboard, labs, ar) and `/v1/*` (interviewprep) to their services; **do not route `/internal/*`**.
- CAPTCHA: set **both** `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (Cloudflare Turnstile) before launch. Without them sign-up, sign-in and OTP requests rely on rate limits alone; the launcher logs a warning at start.
- Internal routes (`/api/internal/*`, `/labs/internal/*`, `/ar/internal/*`, and `/internal/` under any lab) are protected by an internal bearer token **and** the gateway's caller check (loopback peer, no edge headers). Behind a proxy every peer is loopback, so the token is the real control: keep it long, random and out of every other app's environment.
- Per-caller tokens (Render single-origin deployment): the launcher derives one token per caller→callee pair from `INTERNAL_API_TOKEN` with HKDF and passes each child only its own (`INTERNAL_TOKENS_ACCEPT`, `INTERNAL_TOKEN_TO_*`); no child is handed the raw token, and a token that opens one app's internal API opens no other. All processes run as one user, so this is defence in depth, not protection against code running in a child (`deploy/README.md`, "Limits of the isolation"). Every app falls back to `INTERNAL_API_TOKEN` when those variables are absent, so the local setup above is unchanged. Details and the labs child process: `deploy/README.md`.
- CSP `connect-src` stays `'self'` everywhere (plus `blob:` on the gateway, for the 3D interviewer's textures, which three.js reads with `fetch(blob:)`): the browser only ever talks to its own app's origin.

## Publishing to GitHub

This working tree is not a clean repository: six sub-apps (`AI-Security`, `DevSecOps-Simulation`,
`InterviewPrep`, `soc`, `threatready-lab-001`, `ThreatWall`) are their own clones with a `.git`, and
`InterviewPrep/apps/api/assets/interviewer.glb` is a licensed model that must never be downloadable.
Publish with the filter, then check the result before committing there:

```
rsync -a --delete --filter='merge scripts/publish.rsync-filter' ./ ../Threat_Ready/
node scripts/publish-check.mjs ../Threat_Ready
```

The filter leaves out every nested `.git`, any `.glb`, real `.env` files (templates stay), private
keys, `audit/`, build output and local lab data. `publish-check` fails on any of those, on gitlinks and
on files over 25 MB; CI runs it on every push too.

## Known follow-ups

- Identity is cached for `IDENTITY_CACHE_SECONDS` (30 s) per app, on top of Better Auth's 60-second cookie cache, so a revoked session can keep working for up to about 1½ minutes outside onboard (the internal identity endpoint and the admin console bypass the cookie cache).
- InterviewPrep's old local accounts (from before this change) keep their data, but their ids don't match onboard users, so that usage appears in admin totals and not under any onboard user.
- InterviewPrep still lists `better-auth` in its `package.json` files although nothing imports it, and its `sessions`, `accounts` and `verifications` tables are no longer written. Remove both in a cleanup.
- Labs, SOC and Red Team still store progress in JSON files. On Render the launcher mirrors them to PostgreSQL so a restart keeps them (`deploy/README.md`), but that is one instance's backup, not shared state: moving the stores to PostgreSQL is the next step for multi-instance deploys.
- The ADD's staff TOTP requirement now applies to the admin console. Add the Better Auth 2FA plugin and require it for `admin:read`.
- The Playwright browser test for Labs is updated but was not run here (no Chromium installed): `npx playwright install chromium && npm run build && npm run test:e2e`.
- UI regression sweep (`e2e/ui-audit.mjs`, from the Oct 2026 UI/UX audit in `docs/`): every route at eight viewports, no sideways scrolling, lab consoles that fit under the lab strip, and axe-core WCAG 2.1 AA. `cd e2e && E2E_USER=… E2E_PASSWORD=… E2E_SITE=http://localhost:8090 npm run ui-audit`.
