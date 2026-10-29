# ThreatReady: UI/UX, SEO, accessibility and performance corrections (28 October 2026)

| | |
|---|---|
| **Baseline** | `main` @ `7d81555` (GitHub default branch, verified with `git ls-remote --symref`) |
| **Branch** | `feature/ui-ux-seo-accessibility-fixes`, created from `origin/main` with no upstream (`--no-track`); `main` was never checked out, committed to, pushed or merged |
| **Specification** | `THREATREADY_UI_UX_SEO_AUDIT.md` (27 Oct 2026), validated finding by finding against this source tree; plus an independent pass over the same areas |
| **Machine** | Windows 11, Node 26.10, pnpm 12.11 / npm 11.19, Python 3.11 (`py -3.11`), Chrome 156 for Playwright. No Docker: PostgreSQL 16 is the repo's bundled `scripts/local-db.mjs` on 127.0.0.1:55433 |

**Statuses:** PASS = ran and passed · FAIL = ran and failed · BLOCKED = could not run (documented reason) · NOT RUN.

---

## 1. What the audit described vs. what `main` contained

The audit's working tree was never committed. On `main` **none of the audit's implemented fixes were present**: Google Fonts on all 17 marketing pages, no `robots.txt`/`sitemap.xml`, no `X-Robots-Tag`, no `noindex` meta, generic onboard titles, `.module-wide` at 1040 px, four full-width KPI cards on phones, the duplicate `f-company` id, the light-theme contrast tokens, the StrictMode focus bug. Attack Reasoning already had per-page titles for its two not-found screens only. Every item below was therefore implemented afresh on this branch.

## 2. Finding checklist

| ID | Expected | Evidence on `main` | Correction (files) | Validation | Status |
|---|---|---|---|---|---|
| SEO-01 | Public site has `robots.txt` and a sitemap of indexable canonical URLs | Neither file existed | `Landing_Page-main/robots.txt` (Allow all + `Sitemap:`); `tools/sync_shell.py` now writes `sitemap.xml` (16 URLs, root first, no invented `lastmod`); `check_site.py` fails when either is missing, stale, or the robots file does not name the sitemap | `check_site.py` PASS; `test_sitemap_follows_noindex_and_stays_in_sync` PASS | Fixed (not deployed) |
| SEO-02 | Signed-in platform never indexed, crawl still allowed so `noindex` is read | No header, no meta on any shell | `deploy/gateway.mjs` `securityHeaders` sends `X-Robots-Tag: noindex` on every response (labs child inherits it); `_headers` regenerated (`tools/gen-headers.mjs` mirrors it); `<meta name="robots" content="noindex">` in all 9 app shells (onboard, InterviewPrep, Labs, AR, SOC, DevSecOps, ThreatWall, AI Security, Red Team) | gateway test asserts header on `/healthz` and in the 5-kind response test (49/49 PASS); `e2e/ui-audit.mjs` now fails any app route without the meta; curl of the 4 dev shells shows the meta | Fixed (not deployed) |
| SEO-03 | Canonical, OG and Twitter tags complete on every indexable page | 6 legal/trust pages had none; `pilot`, `pricing` lacked `og:description`, `og:image`, `twitter:card` | Added from each page's own title and description (`dpa, privacy, rubric, sample-report, security, terms, pilot, pricing`); checker requires canonical = own URL, `og:url` = canonical, `og:title/description/image`, `twitter:card` | `test_missing_seo_tags_and_google_fonts_fail` PASS | Fixed |
| SEO-04 | Meta description lengths sane | `rubric.html` 270 characters | Rewritten to 149 characters with the same facts; checker limits title ≤ 80, description 50–180, titles and descriptions unique | `check_site.py` PASS | Fixed |
| SEO-05 | Descriptive tab titles (WCAG 2.4.2) | Every onboard route "ThreatReady"; AR domain/attempt/summary/history and the Labs console used the app name only | onboard `usePageTitle()` (`components/ui.tsx`) on Sign in / Create account / Verify / Forgot / Home / Profile / Admin console / "User details · Admin" (no name or email) / Sign out / Page not found; AR `useTabTitle()` (domain title, scenario title, "Assessment summary", "Your assessments"); Labs console `"<lab title> · Lab Simulations · ThreatReady"` | Read back in the browser: "Sign in · ThreatReady", "Home · …", "Profile · …", "Cloud Security · Attack Reasoning Lab · …", "Your assessments · …", "Page not found · …"; sweep fails a bare "ThreatReady" title | Fixed |
| SEO-06 | 1200×630 share image | Not present | Needs brand artwork; not invented | — | Open (needs owner) |
| SEO-07 | Title/description lengths | Titles 69–76 chars on 5 pages; descriptions 172–175 on 2 | Marketing copy, left unchanged; the new checker caps at 80/180 so they cannot grow further | — | Open (recommendation: ~60/155) |
| SEO-08 | Real not-found pages instead of soft redirects | onboard `*` → sign-in; InterviewPrep `*` → dashboard | onboard `pages/NotFoundPage.tsx` (no session needed, titled, links home/sign-in); InterviewPrep `NotFoundScreen` on `*` using the existing `NotFoundState`. Labs and AR already had them | Opened both in the browser | Fixed (status is still 200 from the SPA host; gateway 404 for unknown top-level paths left open) |
| SEO-09 | Structured data matches page | FAQ/Organization JSON-LD match visible text | None needed | Read | No change |
| SEO-10 | `lang` consistency | onboard `en-IN`, others `en` | Left (valid, possibly deliberate for date formats) | — | Open |
| PERF-01 | No render-blocking third-party fonts | Google Fonts CSS + 2 preconnects on all 17 pages; CSP allowed Google | Self-hosted Inter and JetBrains Mono variable fonts (`assets/fonts/`, the `@fontsource-variable` 5.3.0 files the apps already ship, OFL 1.1 licences alongside); `@font-face` in `site.css`; Inter latin preloaded; Google origins removed from every page CSP and from the platform CSP (`deploy/gateway.mjs`, `_headers`, Red Team `hosted-csp.e2e.ts` constant); checker fails on any Google Fonts reference | Browser: `document.fonts` loaded from `assets/fonts`, 0 requests to Google; Lighthouse below | Fixed |
| PERF-02 | Responsive product screenshots | 1600 px WebP only | 800 px variants (7–29 KB vs 18–71 KB) generated with Pillow (quality 82, Lanczos); `srcset`/`sizes` on the 10 `<img class="shot">` tags | Served (`-800.webp` 200) | Fixed |
| PERF-03 | Sign-in page does not download the signed-in app | `main.tsx` imported every page eagerly | `React.lazy` for Product, Profile, Module, Admin (+ `AdminGate` inside the chunk) and Admin user routes; `Suspense` line in `AppShell` | Build: separate chunks `ProductPage` 1.7 KB gz, `ProfilePage` 1.9, `AdminPage` 6.2, `AdminUserPage` 3.6, `ModulePage` 0.3; sign-in → `/app` → `/app/profile` opened in the browser | Fixed |
| PERF-04 | Code-split ThreatWall / AR / Red Team | Single chunks (AR 159 KB gz, Labs 131 KB gz measured here) | Not done (larger change) | — | Open |
| PERF-05 | Smaller `logo-sm.png` | 22 KB | Binary brand asset, left | — | Open |
| PERF-06 | Long cache TTL on threatready.io assets | GitHub Pages 600 s | Cloudflare setting | — | Open (needs access) |
| A11Y-01 | Light-theme heatmap contrast | `.heat td.hi` white on pale violet mix (2.65–4.2:1) | `:root[data-theme="light"] .heat td.hi{background:var(--accent-hover)}` | Browser (light): all 5 cells `rgb(70,54,214)` on white text = 7.6:1 | Fixed |
| A11Y-02 | Light `--bad` ≥ 4.5:1 | `#C2403A` (4.32:1 on its tint) | `--bad:#B0362F`, `--bad-soft` recoloured to match | Browser (light, `rubric.html`): 5.45:1 on the badge, 6.15:1 on white | Fixed |
| A11Y-03 | No duplicate ids | `pilot.html` `id="f-company"` on the form field and the footer heading | Field → `f-org` (label `for` updated; JS does not reference it); checker fails on any duplicate id | `test_duplicate_id_fails` PASS | Fixed |
| A11Y-04 | Heading order in the InterviewPrep empty state | `<h3>` directly under the `<h1>` on History | `Empty` takes `level` (2/3/4, default 3; `.empty-title` keeps the h3 look); History uses 2 | `history-page.test.tsx` asserts an h2 (PASS) | Fixed |
| A11Y-05 | No focus ring on first load in development | `RouteFocus` first-run flag reset by StrictMode | Guard compares the last focused path | Dashboard loaded without a focused h1 | Fixed |
| A11Y-06 | Skip link inside a landmark | Open from October | Not changed | — | Open |
| A11Y-07 | axe "needs review" items | — | Manual review not done here | — | Open |
| UI-01 | Profile aligned with the shell | `.module-wide{max-width:1040px}` in a 1280 px shell | `max-width:none` | Screenshot at 1440×900: cards reach the header/footer edges | Fixed |
| UI-02 | Two KPIs per row on phones | `.grid.cols-4` → one column ≤ 760 px | `.kpi-grid` class on the dashboard summary; 2 columns ≤ 760 px, tighter card and figure, 1 column ≤ 340 px | Measured at 390 px: cards at x=16/200, 174 px wide, 4 cards in 2 rows, no horizontal overflow | Fixed |
| UI-03 | AR score/date cells on one line | wrapped at desktop widths | `.ar-table td.tr-mono, td.tr-small{white-space:nowrap}`; title cell `overflow-wrap:anywhere` | Domain page at 1440 px: one line per row | Fixed |
| UX-01 / UX-02 / UX-03 | Demo paste, footer new-tab links, soft 404s | Product decisions | UX-03 covered by SEO-08 | — | Open (product) |
| CONT-01 | Legal placeholders | `privacy.html:275,278`, `terms.html:260` still contain "[Registered Office Address]" and "[To be appointed]" | **Not fabricated.** These pages are indexable and now in the sitemap | — | **Open (needs business input)** |
| ENV-01 | Local DB migrations current | n/a on `main` | Migrations applied to the local DB only (`migrations applied` for onboard and InterviewPrep) | Services ran clean | Local only |

### Independent findings (self-audit), beyond the audit document

| Finding | Action |
|---|---|
| Platform CSP (`deploy/gateway.mjs`, `_headers`) allowed `fonts.googleapis.com` / `fonts.gstatic.com` although every app self-hosts fonts via `@fontsource` | Removed; gateway test asserts no Google origins in the CSP |
| The six legal/trust pages' CSP still allowed `connect-src https://threatready-db.onrender.com` (an old backend host; the pages make no requests) | Removed with the font change |
| `check_site.py` had no SEO or markup guards | Added: canonical/OG/Twitter, title and description length and uniqueness, duplicate ids, `<img>` `alt` + `width`/`height`, Google Fonts, robots/sitemap sync (+3 unit tests) |
| `e2e/ui-audit.mjs` did not check titles or indexability | Each route must have a non-generic title; each app route must carry the `noindex` meta (2 extra checks per route/viewport) |
| Hosted-lab shells (SOC, DevSecOps, ThreatWall, AI Security, Red Team) had no `noindex` meta either | Added, so the sweep's rule holds for all 9 shells |
| Windows checkout: `core.autocrlf=true` makes `check-landing-csp` (inline-script hashes) and `gen-headers --check` fail on byte comparison | Not a product defect; files edited here are LF. A `.gitattributes` with `* text=auto eol=lf` would make this stop surprising contributors (left for the owner to decide) |
| `scripts/test/publish-check.test.mjs` fails on Windows with a `S:\S:\…` path (file URL joined with a drive path) | Pre-existing, Windows-only; not changed |

## 3. Verification results

| Check | Result |
|---|---|
| `node tools/check-landing-csp.mjs` | PASS 17/17 (LF working copies) |
| `node tools/gen-headers.mjs --check` | PASS |
| `node --test tools/test/*.test.mjs` | PASS 10/10 |
| `python check_site.py --offline` (site links, claims, SEO, sitemap) | PASS, 17 pages |
| `python -m unittest test_site_tools` | PASS 12/12 (3 new) |
| `scripts/publish-check.mjs .` | PASS; `scripts/test` 1/3 PASS, 2 FAIL pre-existing Windows path bug, 1 skipped (no rsync) |
| deploy: `gateway.test.mjs` | PASS 49/49 (the one earlier failure was `.js.map` files in stale local `dist/` folders; gone after rebuilding) |
| deploy: `launcher.test.mjs`, `child-env.test.mjs` | PASS 17/17 · `state-mirror` BLOCKED (needs `STATE_MIRROR_TEST_DATABASE_URL`) · `labs-child` NOT RUN (needs the esbuild bundle; esbuild's install script is blocked by npm policy on this machine) |
| onboard: `pnpm typecheck` (contracts, api, web) | PASS |
| onboard: `pnpm --filter @threatready/web build` | PASS (lazy chunks listed above; no source maps) |
| onboard: web unit tests | PASS 6/6 |
| InterviewPrep: `typecheck -w @threatready/web`, `-w @threatready/api` | PASS (after rebuilding the workspace packages, as CI does) |
| InterviewPrep: web build | PASS |
| InterviewPrep: `vitest` (web) | 101 PASS, 7 skipped, 1 FAIL pre-existing: `avatar-asset.test.ts` needs the licensed `interviewer.glb`, which is deliberately not in the repository |
| Labs: typecheck, build | PASS |
| Labs: `vitest` | 91 PASS, 2 FAIL pre-existing/environmental: `security.test.ts` A9 creates symlinks (Windows `EPERM` without symlink privilege) |
| Attack Reasoning: typecheck, build | PASS |
| Attack Reasoning: `vitest` | PASS 44/44 (one 5 s rate-limit timeout while four builds ran concurrently; 13/13 when re-run alone) |
| Red Team lab: typecheck | PASS |
| Lint | NOT RUN repo-wide (CI skips InterviewPrep lint for 5 known errors); `lint:regexp` not affected (no server regexes changed) |
| UI regression sweep `e2e/ui-audit.mjs` (34 routes × 8 viewports, overflow + console fit + axe WCAG 2.1 AA + the new title/noindex checks; Chrome 156 via `E2E_BROWSER_PATH`) | **766 / 806**. Every overflow, console-fit, axe and title check passed. The 40 failures were one cause: the five hosted labs (SOC, DevSecOps, ThreatWall, Red Team, AI Security) were still served from `dist/` folders built before this change, so the new `noindex` meta was absent *as served*; the Labs API also reads those shells once at boot (`server/hosted.ts`). After rebuilding the five labs as `deploy/build.sh` does and restarting the Labs API, all five `dist/index.html` files carry the meta and the re-run at the two axe viewports (375×812, 1440×900) passed **256 / 256** |
| Lighthouse 12.8.2 mobile, **same machine, back to back**: `main`'s site on :8091 vs this branch on :8090 (uncompressed static server, full dev stack running, `benchmarkIndex` 600–850 so absolute values are low; compare the two columns, not the audit's idle-Linux figures) | **pricing**: performance 88 → **95**, FCP 2.8 s → **1.6 s**, LCP 2.8 s → **1.8 s**, render-blocking 898 ms → **150 ms**, third-party origins 1 → **0**. **index**: render-blocking 334 → **149 ms**, weight 349 → **296 KiB**, CLS 0.107 → **0.000**, third-party 1 → **0**, FCP 3.2 → 3.3 s, but LCP 3.5 → 3.9 s and TBT 36 → 506 ms, score 80 → 63. The TBT rise on index did not reproduce on pricing/rubric and varied 1409/767/506 ms across runs on this loaded machine; the likeliest mechanism is the `font-display: swap` re-layout of the heavy demo page under 4× CPU throttling. The audit measured the same change at 99/100 with 16 ms TBT on an idle Linux box. **Treat index as unconfirmed until re-measured on an idle machine or production**; accessibility 100, SEO 100, best-practices 89 (the demo's paste blocking, UX-01) on all runs |
| Manual browser checks (built-in browser) | Sign in → Home → Profile (1440), AR domain page (1440), onboard and InterviewPrep not-found screens, InterviewPrep dashboard and AR history (390), marketing AR and rubric pages in light theme; no console errors on the pages inspected |
| Screen readers, keyboard-only walkthrough, real devices, 200–400 % zoom | NOT RUN (manual assistive-technology testing is outside what was possible here; automated axe results are not a compliance claim) |

## 4. Local run

All services were started from this checkout and answered on these ports (`localhost`; the Vite servers bind `[::1]`):

| Service | URL |
|---|---|
| onboard web / API | http://localhost:5173 / :3200 (`/api/health` 200) |
| InterviewPrep web / API + worker | http://localhost:5174/interview-prep / :3100 |
| Labs web / API | http://localhost:5175/labs/ / :4000 |
| Attack Reasoning web / API | http://localhost:5176/ar/ / :4100 (proxies `/v1` to :3100) |
| Marketing site (static) | http://localhost:8090/ |
| PostgreSQL 16 (bundled) | 127.0.0.1:55433 |

Reproduce: `node scripts/local-db.mjs` in `Threatready-landing-page-main` (keep open); `pnpm --filter @threatready/contracts build && pnpm --filter @threatready/api build && pnpm db:migrate`; in `InterviewPrep` `npm run build -w @threatready/shared -w @threatready/contracts -w @threatready/db` then `node packages/db/dist/migrate.js` with `.env` loaded; then the per-service commands in the root README ("Run everything locally"). Signed in with the local `.test` account from `.logs/local-test-account.txt` (gitignored, development only).

Not exercised (need credentials, email, OAuth, live LLM calls or an admin account): sign-up verification, password reset, Google/GitHub sign-in, an InterviewPrep interview to report, an Attack Reasoning attempt to evaluation (`LLM_DRIVER=fake` locally), the admin console contents.

## 5. Still needs the owner

1. **CONT-01**: replace "[Registered Office Address]" (privacy, terms) and "[To be appointed]" (privacy) before promoting the sitemap; or add `noindex` to those two pages and re-run `tools/sync_shell.py`, which drops them from the sitemap automatically.
2. Deploy, then confirm `X-Robots-Tag: noindex` on the Render host, publish `robots.txt`/`sitemap.xml`, submit the sitemap in Search Console and Bing.
3. SEO-06 share image (1200×630), SEO-07 title/description copy, PERF-04 code-splitting, PERF-05 logo, PERF-06 Cloudflare TTL, A11Y-06/07, UX-01/02.
4. Optional: `.gitattributes` (`* text=auto eol=lf`) so Windows checkouts pass the hash-based checks unchanged.
