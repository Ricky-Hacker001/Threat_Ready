# ThreatReady: UI/UX, Responsive, Accessibility, SEO and Performance Audit

> Status 29 Oct 2026: these findings were implemented on branch UI/UX (dc7f5f3; docs/UI_UX_SEO_FIXES_2026-10-28.md) and merged with business accounts and the Attack Reasoning cost work on integrate/2026-10-29.

| | |
|---|---|
| **Audit date** | 27 October 2026 |
| **Working tree** | `ThreatReady/` (local working copy; not a git repository at the root). Baseline = a file snapshot taken before any change in this pass. |
| **Builds on** | `docs/THREATREADY_COMPREHENSIVE_UI_UX_AUDIT.md` (23 Oct 2026, 96 findings, 86 fixed). That audit is not repeated here; this pass re-measures it, covers the three apps it could not run, and adds SEO and performance. |
| **Changes** | In the working tree only. **Nothing is committed, pushed or deployed.** |
| **Evidence** | `audit/reports/evidence/*.webp` (before/after screenshots). Raw tool output stayed in the auditor's scratch space and is summarised here. |

**Evidence labels used below:** **M** = measured with a tool in this pass; **RC** = reproduced in a real browser; **SC** = confirmed in source; **LV** = checked against the live site with a read-only request; **J** = expert judgement (not a measurement).

---

## A. Executive summary

### Overall assessment

ThreatReady already looks and behaves like a considered product rather than a generic admin dashboard. All five main apps share one design system (`platform.css`: navy surfaces, a restrained violet accent, Inter and JetBrains Mono, one header with an app switcher). Content is specific to security work, and the 23 October fixes held up: the full regression sweep (overflow at 8 viewports, console fit and axe) passed **366 of 366 checks at baseline**, before anything was changed in this pass.

The weak areas were **technical SEO** and **first-load performance on the public site**, plus some polish on the three apps the October audit could not run (onboard, InterviewPrep, Attack Reasoning).

### Most important findings

1. **The signed-in platform was indexable.** (SEO-02, LV)
   - On `threatready.onrender.com`, every app URL returns 200: the sign-in page, `/app/profile`, `/labs/`, `/ar/`, `/interview-prep/`, and also any made-up path.
   - None of them carries a noindex directive, and every onboard page is titled just "ThreatReady".
2. **The marketing site had no sitemap.** (SEO-01, LV)
   - `threatready.io/sitemap.xml` returns 404.
   - The live `robots.txt` is Cloudflare's managed content-signals text and has no directives.
3. **Google Fonts blocked first paint on every marketing page.** (PERF-01, M) Lighthouse estimated about 1 s of render blocking on mobile; FCP was 2.6–2.9 s.
4. **Six legal and trust pages had no canonical URL or social metadata,** and two product pages had incomplete Open Graph tags. (SEO-03, SC)
5. **The light theme had two contrast failures** (WCAG 1.4.3) on the marketing site, with 12 failing elements in total (A11Y-01, A11Y-02, M):
   - the scoring heatmap: 2.65–4.2:1
   - the rubric's "weak" score badge: 4.32:1
6. **The local development database was two migrations behind the code.** (ENV-01, RC) As a result, InterviewPrep and the Attack Reasoning domain pages answered 500 locally. This is an environment problem, not a product defect, but it hid real UI states from testing.

### Improvements implemented (all verified; see sections E–I)

- **Marketing site:**
  - `robots.txt`, plus a generated `sitemap.xml` (16 pages).
  - Complete canonical, Open Graph and Twitter tags on every indexable page.
  - Self-hosted variable fonts, and a tighter Content Security Policy.
  - Responsive `srcset` for the product screenshots.
  - The two light-theme contrast fixes.
  - A duplicate `id` that mislabelled the footer navigation on `pilot.html`.
  - New checks in `tools/check_site.py`, with unit tests.
- **Platform:**
  - `X-Robots-Tag: noindex` on every gateway response, plus `noindex` in the four SPA shells.
  - Descriptive tab titles in onboard, Attack Reasoning and the Labs console.
  - Lazy-loaded signed-in routes in onboard.
  - Profile page aligned with the shell.
  - Two stat cards per row on InterviewPrep phones.
  - Correct heading level in the InterviewPrep empty state.
  - Attack Reasoning table cells that no longer wrap.
  - A React StrictMode-safe route-focus guard.

**Headline numbers:**

| Measure | Before | After |
|---|---|---|
| Marketing pages, Lighthouse mobile performance (M) | 88–90 | **99–100** |
| Marketing pages, FCP | 2.6–2.9 s | **0.8–1.4 s** |
| Marketing pages, LCP | 2.6–2.9 s | **1.6–1.8 s** |
| Home page weight | 245 KiB | **192 KiB** |
| Deep axe pass: clean page states (M) | 103 / 120 | **112 / 120** |
| Serious axe violations | 12 | **0** |

### Remaining risks and limitations

- **Business and legal input still needed:**
  - The legal pages still contain "[Registered Office Address]" and "[To be appointed]" (CONT-01 from October, still open). Those pages are now in the sitemap.
  - There is no 1200×630 social share image.
- **Not tested:**
  - Flows that need real AI calls: InterviewPrep interviews and reports, and Attack Reasoning attempts and evaluation.
  - Flows that need email or OAuth: sign-up verification, password reset, Google and GitHub sign-in.
  - The admin console: the test account is not an admin.
- **Not run in this pass:** manual screen-reader testing (NVDA, VoiceOver) and full keyboard walkthroughs. Accessibility scores are therefore provisional.
- **How performance was measured:** locally, with Lighthouse's simulated mobile throttling, not on production. The onboard lazy-loading change cut JavaScript but did **not** improve Lighthouse's simulated metrics (H.3).
- **Parallel work:** while this audit ran, other changes landed in the same working tree (InterviewPrep API reasoning and LLM code, `render.yaml`, `deploy/test/child-env.test.mjs`, `tools/regexp-allowlist.txt`, `InterviewPrep/.env.example`, two Attack Reasoning docs, timestamps 15:11–15:25). They are **not** part of this audit and were not touched.

---

## B. Audit scope and methodology

### B.1 Discovery

| Item | Finding |
|---|---|
| Structure | Multi-app platform: 10 front ends, 1 deployment gateway, 1 browser-test harness (`e2e/`). Not a monorepo: six sub-apps are their own git clones. |
| Front ends | React 18/19 + Vite SPAs (onboard, InterviewPrep, Labs, Attack Reasoning, SOC, Red Team, ThreatWall, DevSecOps, AI Security) and a static HTML marketing site (`Landing_Page-main`, GitHub Pages behind Cloudflare). |
| Back ends | Onboard: NestJS + Better Auth (identity provider). InterviewPrep: NestJS monolith with a pg-boss worker (it also hosts the Attack Reasoning engine). Labs and Attack Reasoning: Express gateways. Production: one Render service, `deploy/gateway.mjs` + `deploy/start.mjs`. |
| Styling | Shared `platform.css` tokens (5 identical copies), plus app CSS. The marketing site uses `assets/css/site.css`. |
| Routing | React Router (onboard, InterviewPrep), hand-rolled path routers (Labs, Attack Reasoning). |
| Existing quality gates | `e2e/ui-audit.mjs` (overflow + axe), `tools/check_site.py` (links, claims, platform URLs), `tools/check-landing-csp.mjs`, `tools/gen-headers.mjs --check`, unit tests per app, and a CI workflow (`.github/workflows/ci.yml`). |

### B.2 Pages and routes inspected

- **Marketing site, all 17 pages:**
  - Product: `index`, `attack-reasoning-lab`, `lab-simulations`, `interviewprep`.
  - Company: `pilot`, `pricing`, `how-it-works`, `transparent-scoring`, `resources`, `contact`.
  - Resources: `sample-report`, `rubric`.
  - Legal and trust: `security`, `privacy`, `terms`, `dpa`.
  - `404`.
- **Onboard:**
  - Public: `/` (sign in) and `/?mode=signup`.
  - Signed in: `/app`, `/app/profile`, and `/app/interview` (an old-link redirect).
- **InterviewPrep:** dashboard, `/new`, `/history`.
- **Labs:**
  - The catalog and its four track pages.
  - The `TR-CLOUD-001` console.
  - The entry pages of the five hosted labs (SOC, DevSecOps, ThreatWall, Red Team, AI Security), covered by the sweep.
- **Attack Reasoning:** the domains landing, `/domains/cloud-security` and `/history`.
- **Live, read-only GETs:**
  - `threatready.io`: `/`, `/robots.txt`, `/sitemap.xml`.
  - `threatready.onrender.com`: `/`, a hashed asset, `/robots.txt`, `/app/profile`, `/labs/`, `/ar/`, `/interview-prep/`, and one made-up path.

### B.3 Environment and tools

| Item | Detail |
|---|---|
| Stack | Full local stack from `start-all.sh` (onboard API/web, InterviewPrep API/worker/web, Labs API/web, Attack Reasoning API/web), PostgreSQL in Docker (`tr-interviewprep-pg`), the marketing site served statically. Signed in with the local test account from `e2e/.env` (a `.test` address, development only). |
| Browser automation | Playwright 1.64.0 with Chromium 156.0.8078 |
| Accessibility | axe-core 4.14.0. Two passes: the project's own `e2e/ui-audit.mjs` (WCAG 2.1 A/AA, fails on critical/serious) and a deeper pass written for this audit (WCAG 2.0/2.1/**2.2** A/AA + best practice, every impact level, **dark and light theme**, 1440 and 375 px). |
| Lighthouse | 12.8.2, Google Chrome 156.0.8078.47. Mobile (default simulated throttling) and desktop presets. Marketing pages were served through a small gzip static server with GitHub Pages' 600 s cache header. The onboard sign-in page was served from `vite preview` of the production build, with its API proxied to the local onboard API. |
| Bundles | Every front end built the way `deploy/build.sh` builds it; JS/CSS sizes gzipped at level 9. |
| Viewports | 320×568, 375×812, 430×932, 768×1024, 1024×768, 1366×768, 1440×900, 1920×1080 (sweep). Screenshots at 1440×900 and 390×844, some full-page. |
| Machine | Linux 7.0 desktop, Node 24.21, Python 3.12, with all eight dev servers running during measurements. |

### B.4 Not tested

| Area | Why |
|---|---|
| InterviewPrep interview room, report pages; Attack Reasoning attempt, evaluation and summary pages | Need live LLM calls (cost) and generated content. Their titles and table changes are verified by typecheck and unit tests only. |
| Sign-up verification, password reset, OAuth, Turnstile | Need email delivery, OAuth apps or Cloudflare keys. |
| Admin console (`/app/admin`) | The test account is not an admin; granting admin was out of scope. Its lazy-loading change is covered by typecheck and build. |
| Deep lab playthroughs (TR-CLOUD-001 objectives, SOC L2/L3, Red Team exploit-to-report) | Covered by the October audit; only entry pages were re-swept. |
| Screen readers, real devices, Safari/Firefox | Not run in this pass (`e2e/cross-browser.mjs` exists for engines). |
| Production performance, Core Web Vitals field data, Search Console | No deployment and no Search Console access. All performance numbers are local lab measurements. |

---

## C. Scorecard

### C.1 Rubric

| Band | Meaning |
|---|---|
| 90–100 | No material issues found; best practice met; verified by tools and manual checks |
| 75–89 | Solid; minor issues that do not block a task or mislead |
| 60–74 | Noticeable issues that affect some users or tasks |
| < 60 | Major issues: broken journeys, failed basics, or missing fundamentals |

A score is **provisional** when part of the area could not be tested (see B.4) or when it rests mainly on judgement (**J**).

### C.2 Scores

| Area | Baseline | After | Status | Evidence |
|---|---|---|---|---|
| UI and visual design | 80 | **84** | Provisional (J) | One token system across five apps; restrained palette; consistent cards, tags and status pills (≈40 screenshots reviewed). Deductions: profile misaligned with the shell (fixed); cramped Attack Reasoning score and date cells (fixed); four lab apps dark-only and marketing vs app container widths differ (October VIS-04/VIS-07, open). |
| UX and navigation | 80 | **83** | Provisional (J) | Clear app switcher, breadcrumbs, empty states, "continue where you left off". Deductions: every onboard tab titled "ThreatReady" (fixed); soft 404s on the platform (open); paste blocked in the public demo, internal footer links open new tabs, no jargon glossary (open, product decisions). AI-driven flows not walked. |
| Responsive design | 90 | **92** | Measured (M) | Sweep 366/366 at 8 viewports, before and after: no sideways scrolling, consoles fit under the lab strip. Phone dashboard made denser (−393 px). Deep lab states not re-swept. |
| Accessibility | 84 | **90** | Provisional (M + no manual AT) | Deep axe: 12 serious → 0, 25 → 8 violation nodes; the remaining 8 are one moderate best-practice rule. Duplicate `id` mislabelling a landmark fixed. Not run: screen readers and a full keyboard pass. |
| Technical SEO (public site + platform) | 55 | **86** | Provisional (not deployed) | Before: no sitemap, no robots directives, incomplete metadata on 8 pages, platform indexable with soft 404s and generic titles. After: all fixed in source and enforced by checks. Open: share image, legal placeholders on indexed pages, title lengths, deployment and Search Console submission. Lighthouse SEO was 100 on all marketing pages both times; its checks do not cover these gaps. |
| Performance | 78 | **86** | Measured locally (M); apps provisional | Marketing mobile 88–90 → 99–100. Onboard sign-in JS −11 KiB, with no gain in simulated metrics (H.3). Large single bundles in ThreatWall, Attack Reasoning and Red Team (open). No field data. |
| **Overall** | **78** | **87** | Provisional | Unweighted mean of the six areas above, rounded. |

---

## D. Detailed findings

**Severity** as in the October audit: **Critical** blocks a primary journey or loses data; **High** seriously degrades a core task or is a WCAG A/AA failure on a core flow; **Medium** causes friction or confusion, or is a visible inconsistency, with a workaround; **Low** is polish.

**Status** is Fixed, Open (recommendation), or Open (needs owner).

**Verification** is one of:
- **RC/M**: re-checked in a browser or tool after the fix.
- **T**: covered by an automated test or check added or extended in this pass.
- **SC**: typecheck and build only.

### Environment

| ID | Sev. | Area | Problem and evidence | Impact | Fix | Status | Verified |
|---|---|---|---|---|---|---|---|
| ENV-01 | High | Local dev (InterviewPrep API) | The local DB had 15 of 17 migrations applied (`0016_security_patch_2`, `0017_reasoning_architecture_library` missing). Every InterviewPrep session query and the Attack Reasoning pool count returned 500 (`.logs/interview-api.log`). RC | Dashboards showed "Unavailable" and error states locally; testers and auditors see a broken app | Ran the documented `node packages/db/dist/migrate.js` against the **local** DB only. Recommend that `start-all.sh` warn when migrations are pending. | Fixed locally; the check is Open (recommendation) | RC: no 5xx and 0 console errors across all 120 deep-axe page states after the migration |

### SEO

| ID | Sev. | Page or component | Problem and evidence | Impact | Fix | Status | Verified |
|---|---|---|---|---|---|---|---|
| SEO-01 | High | threatready.io | No `sitemap.xml` (live 404). The repo had no `robots.txt`; the live one is Cloudflare's managed content-signals text with **no** `User-agent` or `Sitemap` lines. LV | Crawlers find pages only through links; no sitemap to submit to Search Console | `robots.txt` (Allow all + `Sitemap:`); `sitemap.xml` generated by `tools/sync_shell.py` from every page without `noindex`, at its canonical URL (16 URLs, no invented `lastmod`). `check_site.py` fails when either is missing or stale. Cloudflare prepends its managed block to an origin `robots.txt`, so both coexist. | Fixed (not deployed) | T: `test_sitemap_follows_noindex_and_stays_in_sync` |
| SEO-02 | High | threatready.onrender.com (all apps) | The signed-in platform was indexable: no `X-Robots-Tag`, no robots meta. Every path (including `/this-page-does-not-exist`) returns 200 with the sign-in shell. LV | Sign-in and app shells can appear in results as thin duplicate pages titled "ThreatReady"; conflicts with threatready.io | `X-Robots-Tag: noindex` on every gateway response (`deploy/gateway.mjs` `securityHeaders`, which the labs child also uses), plus `<meta name="robots" content="noindex">` in the onboard, InterviewPrep, Labs and Attack Reasoning shells (for previews and a static Cloudflare host). `robots.txt` still allows crawling so the noindex can be read. | Fixed (not deployed) | T: gateway test asserts the header on `/`, `/labs/`, `/ar/`, `/interview-prep/`, 404 and 5xx (49/49 pass). RC: meta present on all 13 app routes |
| SEO-03 | Medium | `privacy`, `terms`, `dpa`, `security`, `rubric`, `sample-report`; `pilot`, `pricing` | The six legal and trust pages had no canonical, `og:*` or `twitter:card`. `pilot` and `pricing` lacked `og:description`, `og:image` and `twitter:card`. SC | Shared links render without a description or image; no canonical signal | Added the missing tags, using each page's existing title and description. `check_site.py` now requires canonical = `https://threatready.io/<page>`, `og:title/description/image/url` and `twitter:card` on every indexable page. | Fixed | T: `test_missing_seo_tags_and_google_fonts_fail` |
| SEO-04 | Low | `rubric.html` | Meta description was 266 characters. SC | Truncated in results | Rewritten to 158 characters with the same facts. Checker hard limits: title ≤ 75, description ≤ 180. | Fixed | T |
| SEO-05 | Medium | onboard (all routes), Attack Reasoning domain, attempt, summary and history pages, Labs console | Tab titles were generic: every onboard page was "ThreatReady"; Attack Reasoning domain and history pages and the TR-CLOUD-001 console used the app name only. RC | WCAG 2.4.2 (page titled); history, bookmarks and tabs indistinguishable | onboard `usePageTitle()` ("Sign in · ThreatReady", "Create account", "Home", "Profile", "Admin console", "User details · Admin" with no name or email in the title, "Sign out"); Attack Reasoning `useTabTitle()` ("Cloud Security · Attack Reasoning Lab · ThreatReady", etc.); Labs console "The Compromised Startup · Lab Simulations · ThreatReady" | Fixed | RC: titles read back from the DOM on all 13 app routes |
| SEO-06 | Low | All marketing pages | `og:image` is the 414×398 logo with `twitter:card=summary`; there is no 1200×630 share card. SC | Plain link previews on LinkedIn and X | Needs a brand-approved 1200×630 image; then switch to `summary_large_image`. Not created here, to avoid inventing brand artwork. | Open (needs owner) | — |
| SEO-07 | Low | 5 marketing pages | Titles of 71–73 characters (`attack-reasoning-lab`, `interviewprep`, `pilot`) and descriptions of 171–172 (`lab-simulations`, `transparent-scoring`). SC | The "· ThreatReady" suffix is cut off in results | Shorten to about 60 / 155 characters (marketing copy; not changed). | Open (recommendation) | — |
| SEO-08 | Low | Platform | Soft 404s: unknown onboard paths redirect to sign-in and unknown InterviewPrep paths to the dashboard, all with status 200. LV/SC | Mitigated by SEO-02; still poor UX for mistyped links | A real not-found page in onboard (Labs, SOC and DevSecOps already have one) and a 404 status from the gateway for unknown top-level paths | Open (recommendation) | — |
| SEO-09 | Info | `index.html` | FAQPage and Organization JSON-LD: all 5 FAQ questions and answers match visible page text (checked). Google shows FAQ rich results only for authoritative government and health sites since 2023, so no rich result should be expected. | — | Keep as is; nothing fabricated | No change | M |
| SEO-10 | Low | onboard `index.html` | `lang="en-IN"` while every other app and the site use `en`. SC | Inconsistent; harmless | Pick one. Not changed (it may be deliberate). | Open | — |

### Performance

| ID | Sev. | Page or component | Problem and evidence | Impact | Fix | Status | Verified |
|---|---|---|---|---|---|---|---|
| PERF-01 | High | All 16 marketing pages | Google Fonts CSS was render-blocking (Lighthouse: about 1,030 ms on index, mobile) and added two third-party origins. Visitors' IP addresses also went to Google, which matters for a GDPR-scoped privacy policy. M | FCP 2.6–2.9 s on simulated mobile | Self-hosted Inter and JetBrains Mono variable fonts: the same `@fontsource-variable` files the apps ship, latin + latin-ext, SIL OFL licences included. Inter latin is preloaded; `font-display: swap`. CSP `style-src` and `font-src` no longer allow Google. | Fixed | M: mobile FCP 2.6–2.9 → 0.8–1.4 s. T: checker fails on any Google Fonts link |
| PERF-02 | Medium | `index`, `attack-reasoning-lab`, `interviewprep` | 1600 px product screenshots displayed at 307–760 px (Lighthouse: 113 KiB savings on index). M | Wasted mobile bandwidth | 800 px WebP variants + `srcset`/`sizes` (variants are 7–30 KB vs 19–73 KB) | Fixed | M: index weight 245 → 192 KiB |
| PERF-03 | Medium | onboard sign-in (`/`) | The public sign-in page downloaded the whole signed-in app, admin console included (Lighthouse: 85 KiB unused JS). M | Slower first visit, which grows with the admin console | `React.lazy` for the product, profile, module and admin routes (AdminGate kept inside the lazy chunk); a `Suspense` line in AppShell | Fixed; small benefit | M: JS transferred 148 → 137 KiB, unused JS 85 → 74 KiB, script evaluation −12%, observed LCP −17%. Simulated Lighthouse **not** improved (H.3) |
| PERF-04 | Medium | ThreatWall, Attack Reasoning, Red Team | Single-chunk bundles: ThreatWall 921 KB (260 KB gz) loaded up front; Attack Reasoning 528 KB (163 KB gz); Red Team 566 KB (151 KB gz). M | Slow first load on mid-range phones | Route-level code splitting (lazy pages and the diagram and terminal libraries) | Open (recommendation) | — |
| PERF-05 | Low | All apps | `logo-sm.png` is 128×122, 22 KB, displayed at 26–38 px on every page and loading screen. A 256-colour PNG of the same size measured 6.6 KB. M | About 15 KB per first view | Re-export the brand asset (or use the SVG). Not changed: binary brand asset. | Open (recommendation) | — |
| PERF-06 | Low | threatready.io | GitHub Pages serves static assets with `max-age=600` (Lighthouse `uses-long-cache-ttl`). LV | Repeat visits re-validate fonts, CSS and images | A Cloudflare cache rule (browser TTL) for `/assets/*`; needs Cloudflare access | Open (needs access) | — |

### Accessibility

| ID | Sev. | Page or component | Problem and evidence | Impact | Fix | Status | Verified |
|---|---|---|---|---|---|---|---|
| A11Y-01 | High | `attack-reasoning-lab.html`, light theme | Heatmap cells marked `.hi` had white text on a light violet mix: 3.1, 3.1, 3.1, 4.2 and 2.65:1 (5 cells). M | WCAG 1.4.3 failure on the scoring explanation | Light theme only: those cells use solid `--accent-hover` (#4636D6), 7.6:1 with white | Fixed | M: axe clean, both themes. Evidence `heatmap-light-*` |
| A11Y-02 | High | `rubric.html` (and every `--bad` use), light theme | `.example-score.weak`: #C2403A on its own tint, 4.32:1. M | WCAG 1.4.3 | Light `--bad` token #C2403A → #B0362F (≥5:1 on white and on `--bad-soft`) | Fixed | M |
| A11Y-03 | Medium | `pilot.html` | `id="f-company"` was used by the form's Organisation field **and** the footer's "Company" heading. The footer `<nav aria-labelledby="f-company">` therefore took its name from the empty input. M (axe "needs review") + SC | The footer landmark gets the wrong name in screen readers | Form field renamed to `f-org`; `check_site.py` now fails on duplicate ids on any page | Fixed | T: `test_duplicate_id_fails` |
| A11Y-04 | Medium | InterviewPrep History | The empty state used `<h3>` directly under the page `<h1>` (axe `heading-order`). M | Skipped level in the heading outline | `Empty` takes `level` (default 3); History uses 2; visual size unchanged | Fixed | T: history test asserts an h2; M |
| A11Y-05 | Low | InterviewPrep (development) | `RouteFocus` skipped the first screen with a flag that React StrictMode's double effect run reset, so in development the h1 was focused on load and drew a focus ring (`ip-dashboard-1440-before`). Production was not affected. RC | Misleading local QA and screenshots | The guard compares the last focused path instead of a first-run flag | Fixed | RC: `ip-dashboard-1440-after` |
| A11Y-06 | Low | `sample-report.html`, TR-CLOUD-001 | axe `region` (moderate, best practice): the skip link sits outside a landmark. M | Minor | Wrap skip links in a landmark or accept (October audit left it open) | Open | — |
| A11Y-07 | Info | Several pages | axe "needs review" items: colour contrast over gradients and images (938 nodes), `aria-prohibited-attr` (64, on the Labs catalog, the profile, the site index and the sample report), `label-content-name-mismatch` (22, TR-CLOUD-001). M | Unknown until checked by hand | Manual review recommended. The only one confirmed as a real defect was A11Y-03. | Open (manual review) | — |

### UI, UX and responsive

| ID | Sev. | Page or component | Problem and evidence | Impact | Fix | Status | Verified |
|---|---|---|---|---|---|---|---|
| UI-01 | Medium | onboard `/app/profile` | Content capped at 1040 px inside the 1280 px shell, so cards stop about 240 px short of the header and footer edges at 1440 px (`profile-1440-before`). RC | Looks unfinished next to the home page | `.module-wide { max-width: none }`: the profile uses the shell width | Fixed | RC: `profile-1440-after` |
| UI-02 | Medium | InterviewPrep dashboard, phones | Four KPI cards stacked full-width (the 390 px page was 3,688 px tall). RC | A screen and a half of scrolling before any action | Two KPIs per row ≤ 760 px, tighter padding; one column ≤ 340 px | Fixed | RC: 3,688 → 3,295 px; sweep 0 overflow at 320–430 px |
| UI-03 | Low | Attack Reasoning tables (domain, history, summary) | At desktop widths "83 · correct" and "21 Oct 2026, 15:08" wrapped onto two lines. RC | Ragged rows | Score and date cells `nowrap`; the title cell wraps | Fixed | RC: `ar-domain-1440-after` |
| UX-01 | Low | `index.html` live demo | Copy and paste are blocked in the demo answer box ("as in the product"); Lighthouse best practices 89. M | Hurts users of dictation and clipboard tools in a public demo with no integrity stakes | Allow paste in the public demo; keep blocking in scored sessions | Open (product decision) | — |
| UX-02 | Low | Marketing footer | Internal Resources and Legal links open in new tabs (enforced by `check_site.py`). SC | Unexpected tab spawning; Back does not work | Same tab for own-site pages | Open (product decision) | — |
| UX-03 | Low | Platform | See SEO-08 (soft 404s) | — | — | Open | — |

### Still open from 23 October (re-checked)

| ID | Status today |
|---|---|
| CONT-01 | **Still open:** `privacy.html:282,285` and `terms.html:267` contain "[Registered Office Address]" and "[To be appointed]". These pages are indexable and now listed in the sitemap. Needs business input before promotion. |
| VIS-04, VIS-07 (part), UX-20, CONT-04, VIS-09 | Unchanged (design and product decisions; glossary; repo-wide token sweep). |

---

## E. Before-and-after comparison

### E.1 Screenshots (`audit/reports/evidence/`)

| Change | Before | After |
|---|---|---|
| Profile aligned with the shell (UI-01) | `profile-1440-before.webp` | `profile-1440-after.webp` |
| Phone dashboard, two KPIs per row (UI-02) | `ip-dashboard-390-before.webp` | `ip-dashboard-390-after.webp` |
| No focus ring on load in development (A11Y-05) | `ip-dashboard-1440-before.webp` | `ip-dashboard-1440-after.webp` |
| Attack Reasoning table cells (UI-03) | `ar-domain-1440-before.webp` | `ar-domain-1440-after.webp` |
| Light-theme heatmap contrast (A11Y-01) | `heatmap-light-before.webp` | `heatmap-light-after.webp` |
| Self-hosted fonts render identically | — | `site-index-1440-after.webp`, `onboard-signin-390-after.webp` |

### E.2 Measured results

| Measure | Before | After | Tool |
|---|---|---|---|
| UI regression sweep (`e2e/ui-audit.mjs`, 37 routes × 8 viewports + console fit + axe serious) | 366/366 pass | **366/366 pass** | Playwright + axe |
| Deep axe: clean page states (120 = 30 pages × 2 themes × 2 widths) | 103 | **112** | axe 4.14, WCAG 2.2 AA + best practice |
| Deep axe: violation nodes (serious / moderate) | 12 / 13 | **0 / 8** | same |
| Console errors across those 120 states | 0* | 0 | Playwright |
| Builds (9 front ends) | 9/9 pass | **9/9 pass** | `vite build` |
| Onboard production build: sign in → `/app` → `/app/profile` → `/app/admin` (non-admin) | — | **Pass:** titles "Sign in", "Home", "Profile"; lazy chunks load; the non-admin is sent to `/app`; 0 console errors | Playwright on `vite preview` |
| Lighthouse mobile performance, marketing pages | 88–90 | **99–100** | Lighthouse 12.8.2 |

\* After ENV-01 was fixed. Before that fix, InterviewPrep and Attack Reasoning pages logged 500s.

---

## F. SEO audit results

| Item | threatready.io (public site) | threatready.onrender.com (platform) |
|---|---|---|
| Indexing intent | Index all 16 content pages; `404.html` noindex | **Index nothing** (sign-in, dashboards, labs, reports) |
| robots.txt | **Added:** `Allow: /` + `Sitemap:`. Cloudflare's managed content signals are prepended at the edge. | Unchanged (`Disallow: /api/`, internal paths); crawl stays allowed so `noindex` is seen |
| Sitemap | **Added:** 16 canonical URLs, generated and checked | None (correct) |
| noindex | Only on `404.html` | **Added:** `X-Robots-Tag: noindex` on every response + meta in 4 SPA shells |
| Canonical | **All 16 pages** (was 10) | n/a |
| Titles | Unique on all 17; 3 are over 70 characters (SEO-07) | **Descriptive per page** (was "ThreatReady" on every onboard route) |
| Descriptions | Unique; rubric fixed (266 → 158 characters); 2 at 171–172 | Static description on onboard only (noindex, so low value) |
| Open Graph / Twitter | **Complete on all 16** (was 8 complete, 2 partial, 6 missing) | n/a |
| Structured data | Organization + FAQPage on index; FAQ text matches the page | none |
| Headings | One `h1` per page on all 30 page states checked | same |
| Image alt text and dimensions | Every `<img>` has `alt` and `width`/`height` (no CLS: 0.000) | — |
| HTTPS / compression | Cloudflare, Brotli (LV) | Render edge Brotli; hashed assets `immutable` (LV) |
| JavaScript rendering | Static HTML: content available without JS | SPA shells; irrelevant once noindexed |
| Broken internal links | 0 (`check_site.py`) | — |
| Remaining | SEO-06 share image, SEO-07 lengths, CONT-01 placeholders on indexed legal pages, deploy + submit sitemap in Search Console | SEO-08 soft 404s |

Nothing in the sitemap or metadata exposes private routes, user data or internal APIs. No ratings, reviews or organisation details were added.

---

## G. Accessibility and responsive testing

### G.1 Verified

- **Automated, both themes:** WCAG 2.0/2.1/2.2 A and AA plus best-practice rules on 30 pages, at 1440 and 375 px, in dark and light (120 states).
  - After the fixes, 0 critical or serious and 0 minor violations.
  - One moderate rule remains (A11Y-06).
  - WCAG 2.2 `target-size` had no violations.
- **Responsive sweep:** no horizontal overflow at 8 viewports from 320 to 1920 px on 37 routes. The TR-CLOUD-001 console fits the viewport under the lab strip at every width of 768 px and above.
- **Titles and structure:** exactly one `h1` and a descriptive `<title>` on every app route (DOM read-back).
- **Focus:** in InterviewPrep, a route change still moves focus to the new `h1`. The first screen no longer does, in development or production (RC, A11Y-05).

### G.2 Failures fixed

A11Y-01 to A11Y-05 and UI-02, as listed in section D.

### G.3 Untested

- Screen readers: NVDA, JAWS, VoiceOver, TalkBack.
- A full keyboard-only walkthrough of every flow. This pass relied on the October audit's runtime keyboard checks; nothing changed in the components it tested.
- Zoom at 200–400% and text-spacing overrides.
- Real touch devices.
- Reduced motion. The CSS honours `prefers-reduced-motion` (source), but this pass did not run it.

---

## H. Performance results

### H.1 Marketing site: Lighthouse 12.8.2, served locally with gzip and GitHub Pages' cache header

Same machine, same conditions, single run per page:

| Page | Perf | A11y | Best pr. | SEO | FCP (s) | LCP (s) | TBT (ms) | CLS | Weight (KiB) |
|---|---|---|---|---|---|---|---|---|---|
| index (mobile) | 88 → **99** | 100 → 100 | 89 → 89 | 100 → 100 | 2.9 → **1.1** | 2.9 → **1.8** | 0 → 16 | 0 → 0 | 245 → **192** |
| index (desktop) | 98 → **100** | 100 → 100 | 89 → 89 | 100 → 100 | 0.9 → 0.3 | 0.9 → 0.4 | 0 → 0 | 0.001 → 0 | 245 → 192 |
| pricing | 90 → **100** | 100 | 100 | 100 | 2.6 → **0.8** | 2.6 → **1.6** | 0 → 0 | 0 | 92 → 91 |
| lab-simulations | 89 → **100** | 100 | 100 | 100 | 2.8 → **1.1** | 2.8 → **1.6** | 0 → 0 | 0 | 123 → 131 |
| rubric | 89 → **100** | 100 | 100 | 100 | 2.8 → **1.1** | 2.8 → **1.7** | 0 → 0 | 0 | 132 → 141 |
| sample-report | 88 → **99** | 100 | 100 | 100 | 2.9 → **1.4** | 2.9 → **1.8** | 0 → 86 | 0 | 139 → 147 |

Notes on the table:

- **Pages without product screenshots got about 8 KiB heavier.** The self-hosted latin variable fonts are slightly larger than Google's per-weight subsets. They are same-origin, preloaded and cacheable, which is where the FCP gain comes from.
- **Best practices 89 on index** is the paste blocking in the demo (UX-01).
- **Small TBT values** (16, 86 ms) are within run-to-run noise on this machine.

### H.2 Bundles: gzipped JS + CSS referenced by `index.html` (initial load), from production builds

| App | Before | After | Note |
|---|---|---|---|
| onboard | 153 KB | **142 KB** | Main chunk 141 → 131 KB; admin, profile and product pages now separate (6 KB admin chunk) |
| InterviewPrep | 214 KB | 214 KB | three.js (375 KB gz) already lazy |
| Labs | 140 KB | 140 KB | — |
| Attack Reasoning | 171 KB | 171 KB | single 159 KB chunk (PERF-04) |
| ThreatWall | 273 KB | 273 KB | single 260 KB chunk (PERF-04) |
| Red Team | 161 KB | 161 KB | single chunk (PERF-04) |
| DevSecOps | 132 KB | 132 KB | — |
| AI Security | 116 KB | 116 KB | jsPDF lazy |

### H.3 Onboard sign-in page: before/after A/B

Setup: the baseline bundle was rebuilt from the pre-change source. Its hash is `index-1H69fQ9B.js`, identical to the one live in production. Both bundles were served by `vite preview` and measured alternately, three Lighthouse mobile runs each:

| | Perf (median) | LCP (median, simulated) | TBT (median) | JS transferred | Unused JS | Observed LCP (unthrottled trace) |
|---|---|---|---|---|---|---|
| Before | 94 | 2.56 s | 92 ms | 148 KiB | 85 KiB | 364–396 ms |
| After | 92 | 2.85 s | 110 ms | **137 KiB** | **74 KiB** | **309–331 ms** |

**Reading:** the change reduced bytes and main-thread script time (scripting 435–514 ms → 380–450 ms per run), and the real, unthrottled trace paints sooner. Lighthouse's *simulated* LCP came out about 0.3 s higher, within the spread of single runs (79–94 across all runs this session). So the benefit is real but small and **not confirmed by the simulated score**. It is kept because it stops the public page from growing with the admin console; the cost is one small cached chunk on the first visit to `/app`.

**Limitations:**
- These are local lab measurements on a loaded development machine, not production.
- There is no field (CrUX) data.
- The signed-in apps were not profiled with Lighthouse: their pages need a session, and their bundles are dominated by app code this pass did not change.

---

## I. Implementation changelog

These are changes made by this audit only. Build output (`dist/`) was regenerated and is not listed. The `.webp` evidence files and this report are new.

| File | Change | Why |
|---|---|---|
| `Landing_Page-main/*.html` (17) | Google Fonts links and preconnects removed; Inter preload added; CSP `style-src`/`font-src` no longer list Google (`404.html`: CSP only) | PERF-01 |
| `Landing_Page-main/{dpa,privacy,rubric,sample-report,security,terms,pilot,pricing}.html` | canonical, `theme-color`, `og:*`, `twitter:card` added where missing | SEO-03 |
| `Landing_Page-main/rubric.html` | description 266 → 158 characters | SEO-04 |
| `Landing_Page-main/{index,attack-reasoning-lab,interviewprep}.html` | `srcset`/`sizes` on product screenshots | PERF-02 |
| `Landing_Page-main/pilot.html` | form field id `f-company` → `f-org` | A11Y-03 |
| `Landing_Page-main/assets/css/site.css` | `@font-face` (self-hosted); light `--bad` #B0362F; light `.heat td.hi` background | PERF-01, A11Y-01, A11Y-02 |
| `Landing_Page-main/assets/fonts/` (new) | Inter and JetBrains Mono variable woff2 (latin, latin-ext) + OFL licences | PERF-01 |
| `Landing_Page-main/assets/img/product/*-800.webp` (new, 6) | 800 px variants | PERF-02 |
| `Landing_Page-main/robots.txt`, `sitemap.xml` (new) | crawl directives and sitemap | SEO-01 |
| `Landing_Page-main/tools/sync_shell.py` | writes `sitemap.xml` (`SITE_URL`, `canonical_url`, `indexable`, `sitemap`) | SEO-01 |
| `Landing_Page-main/tools/check_site.py` | new checks: canonical, title and description length, OG and Twitter tags, sitemap in sync, robots names sitemap, no Google Fonts, duplicate ids | Regression guards |
| `Landing_Page-main/tools/test_site_tools.py` | +3 tests (SEO tags and fonts; sitemap and noindex; duplicate id) | Regression tests |
| `deploy/gateway.mjs` | `X-Robots-Tag: noindex` in `securityHeaders` | SEO-02 |
| `deploy/test/gateway.test.mjs` | `x-robots-tag` added to the headers asserted on every response type; explicit `noindex` assertion | Regression test |
| `Threatready-landing-page-main/apps/web/index.html`, `InterviewPrep/apps/web/index.html`, `threatready-lab-001/client/index.html`, `attack-reasoning/client/index.html` | `<meta name="robots" content="noindex">` | SEO-02 |
| `Threatready-landing-page-main/apps/web/src/components/ui.tsx` | `usePageTitle()` | SEO-05 |
| `…/pages/{Auth,Product,Profile,Admin,AdminUser,Module,SignOut}Page.tsx` | per-page titles (no personal data in the admin user title) | SEO-05 |
| `…/src/main.tsx`, `…/components/AppShell.tsx`, `…/styles/app.css` | lazy signed-in routes, `Suspense` + `.page-loading`; `.module-wide` full width | PERF-03, UI-01 |
| `InterviewPrep/apps/web/src/app/App.tsx` | StrictMode-safe `RouteFocus` | A11Y-05 |
| `InterviewPrep/apps/web/src/ui/components.tsx`, `ui/theme.css` | `Empty` `level` prop + `.empty-title`; phone KPI grid | A11Y-04, UI-02 |
| `InterviewPrep/apps/web/src/features/interview-prep/pages/{Dashboard,History}Page.tsx` | `kpi-grid` class; empty state `level={2}` | UI-02, A11Y-04 |
| `InterviewPrep/apps/web/test/history-page.test.tsx` | asserts the empty-state heading is an h2 | Regression test |
| `attack-reasoning/client/src/reasoning/pages.tsx`, `client/src/app.css` | `useTabTitle()` on domain, attempt, summary and history pages; `nowrap` score and date cells | SEO-05, UI-03 |
| `threatready-lab-001/client/src/App.tsx` | console tab title from the lab definition | SEO-05 |
| `audit/reports/THREATREADY_UI_UX_SEO_AUDIT.md`, `audit/reports/evidence/` (new) | this report and its screenshots | Deliverable |

**Local environment (not a source change):** InterviewPrep migrations 0016 and 0017 were applied to the local development database (ENV-01).

---

## J. Outstanding issues and recommendations

| Priority | Item | Depends on |
|---|---|---|
| **High** | CONT-01: replace "[Registered Office Address]" and "[To be appointed]" in `privacy.html` and `terms.html` before promoting the sitemap | Business and legal details |
| **High** | Deploy: merge these changes; check `X-Robots-Tag` on `threatready.onrender.com`; publish `robots.txt` and `sitemap.xml` on threatready.io; submit the sitemap in Google Search Console and Bing Webmaster Tools | Repo and Render access; Search Console verification |
| **High** | Run the untested flows (B.4) on staging: sign-up with email code, password reset, OAuth, one InterviewPrep interview to report, one Attack Reasoning attempt to evaluation, admin console | Staging with email, OAuth and LLM keys; an admin test account |
| Medium | PERF-04: code-split ThreatWall, Attack Reasoning and Red Team | Engineering time |
| Medium | SEO-08: real not-found page in onboard; gateway 404 for unknown top-level paths | — |
| Medium | Screen-reader pass (NVDA + Chrome, VoiceOver + Safari) on sign-in, Labs catalog, one lab console, InterviewPrep room, Attack Reasoning attempt | — |
| Medium | ENV-01 follow-up: make `start-all.sh` warn on pending InterviewPrep and onboard migrations | — |
| Low | SEO-06 1200×630 share card; SEO-07 title and description lengths; SEO-10 `lang` | Brand and marketing copy |
| Low | PERF-05 logo re-export; PERF-06 Cloudflare browser TTL for `/assets/*` | Brand asset; Cloudflare access |
| Low | UX-01 allow paste in the public demo; UX-02 same-tab footer links; A11Y-06 skip link inside a landmark; A11Y-07 manual review of axe "needs review" items | Product decisions |

---

## K. Final acceptance checklist

| Check | Result |
|---|---|
| Builds (9 front ends, `deploy/build.sh` commands) | ✅ 9/9 pass, before and after |
| Typecheck: onboard web, Labs, Attack Reasoning (InterviewPrep web via its build) | ✅ pass |
| Unit tests | ✅ InterviewPrep web 108/108 · Labs 93/93 · Attack Reasoning 63/63 · gateway 49/49 · onboard web 6/6 · repo tools 10/10 · site tools 12/12 |
| Static checks | ✅ `check_site.py`, `check-landing-csp.mjs` (17/17), `gen-headers.mjs --check` |
| Lint (changed InterviewPrep files; CI skips repo-wide lint for 5 known errors) | ✅ eslint clean |
| Functionality: routes load, sign-in works, no console errors | ✅ 30 page states × 4 (themes, widths), 0 console errors. ⚠️ AI flows, email, OAuth and admin not exercised |
| Responsiveness | ✅ 366/366 sweep checks at 8 viewports |
| Accessibility (automated) | ✅ 0 serious or critical. ⚠️ Manual assistive-technology testing not done |
| SEO | ✅ in source, enforced by checks. ⚠️ Not deployed; CONT-01 open |
| Performance | ✅ Marketing 99–100 (mobile, local). ⚠️ No production or field data; app bundles PERF-04 open |
| Changes committed / deployed | ❌ Not committed, not deployed (by design: owner review first) |
| Report | ✅ This document |

---

## L. Final verdict

**Ready for staging; additional work required before treating the public launch as finished.**

- **Why staging:**
  - Every change builds, typechecks and passes the existing and new tests.
  - The regression sweep is unchanged at 366/366.
  - Automated accessibility improved to zero serious issues in both themes.
  - The public site's first paint is about twice as fast in lab measurements.
  - No API contract, authentication rule or business logic was changed. The only server change is one response header.
- **Why not "production-ready" as an unqualified claim:**
  - The legal pages still carry placeholders (CONT-01).
  - The SEO changes only take effect once deployed and submitted.
  - The AI-driven, email and OAuth journeys and the admin console were not exercised in this pass.
  - No screen-reader testing was done.

  Closing the three **High** items in section J would support a production sign-off.
