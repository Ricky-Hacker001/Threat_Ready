# ThreatReady public site — Step A audit & Step B plan

Audit date: 13 Oct 2026 · Source: `Landing_Page-main (1).zip` (files dated 26 Aug 2026)
No code was changed during this audit.

> **Blueprint PDF was not attached.** Only the ZIP arrived. Everything below that depends on the
> blueprint (claims register, exposure rules, verified hosting statements) is taken from the master
> prompt's restatement, the codebase, and the existing legal/security pages — not from the PDF.

---

## 1. Stack & structure

| Item | Finding |
|---|---|
| Public site | Hand-written static HTML. No framework, no `package.json`, no bundler, no lint/test tooling. |
| Landing page | `index.html` — **346 KB single file**: ~2,500 lines inline CSS, ~1,650 lines markup, ~1,480 lines inline JS, 76 inline `style=""` attributes, many large commented-out blocks ("ROUND nn … per user request"). |
| Subpages | 9 pages share `legal.css` (63 KB) + `back-to-top.js`. |
| Product app | `/app/` — **compiled Vite/React build only** (no source). Active bundle `index-BkpVKs77.js` (1.7 MB) + **~70 stale bundles** from older builds also shipped. Router `basename:/app`. |
| Backend | `https://threatready-db.onrender.com` (Render). Not in the ZIP. |
| Hosting | GitHub Pages: root `CNAME` = `threatready.io`; SPA 404 redirect (`rafgraph/spa-github-pages`) for `/app/*`. `app/CNAME` (`app.threatready.io`) has no effect inside a subfolder. |
| Build | None for the public site — files are served as-is. |
| Fonts | Inter (Google Fonts). No JetBrains Mono. |
| Theme | Light default; `data-theme` + `localStorage['tr-theme']`; pre-paint script exists (no flash). |
| Analytics | **None configured.** GA hosts are whitelisted in CSP but no tag/ID exists. |

## 2. Route inventory

### Public routes (redesign scope)
| Route | Purpose | Notes |
|---|---|---|
| `/` `index.html` | Landing | 19 sections (see §4) |
| `/how-it-works.html` | 4-step explainer | Short; opens in new tab from nav |
| `/transparent-scoring.html` | 5 dimensions + 3-pass engine | |
| `/rubric.html` | Full published rubric, bands, appeal process | Appeal: 14 days, engineer review in 7 business days ✔ |
| `/sample-report.html` | Sample report | Labelled "fictional user" ✔ — but shows **"ID verified · Webcam active · Screen recorded"** (proctoring not evidenced in app build) |
| `/pilot.html` | B2B pilot request form | **Form broken** (see §5) |
| `/security.html` `/privacy.html` `/terms.html` `/dpa.html` | Legal/trust | Contain `[Registered Office Address]` placeholder |
| `/404.html` | 404 + SPA redirect for `/app/*` | Must be preserved exactly in behaviour |

**Missing routes the target IA needs:** pricing page, product detail pages (Lab / Simulations / InterviewPrep), Attack of the Week page, "For Teams" page (pilot.html can serve), contact page. `report-sample-b2c.html` is referenced in JS but does not exist. Legal pages link to `index.html#pricing`.

### Application routes (preserve, do not redesign)
From the compiled router: `/app/` · `/app/auth` · `/app/trial` · `/app/trial/complete` · `/app/roles` · `/app/role/:id/difficulty` · `/app/interview/*` · `/app/results` · `/app/dashboard/*` · `/app/hr/*` (B2B dashboard) · `/app/assess` (candidate invite via `assess_token`).

### Entry points used by the landing page (contract to preserve)
- `https://threatready.io/app/` — Sign in
- `https://threatready.io/app/auth?mode=signup` / `?mode=signup&plan=free` — Start free
- `…/auth?plan=single|multi` and modal-built `…/auth?mode=&plan=&email=|provider=` — pricing CTAs
- `POST https://threatready-db.onrender.com/api/demo/evaluate` body `{question, answer}` → `{score, ti, cr, ab, cq, fa, feedback?, model?, level?, error?}`

## 3. Feature status (evidence from the Aug-26 app build + your stated status)

| Capability | Evidence | Status to show |
|---|---|---|
| Attack Reasoning Lab (5 adaptive Qs, 5-dim scoring) | `/api/session/*`, `/api/evaluate`, landing copy | Live |
| InterviewPrep (JD + resume → interview, report) | `/api/interview/analyze|chat|generate-report`, `/api/resume/*` | Live |
| Lab Simulations | **No trace in app build** | **Being built — label "Rolling out"** |
| Free trial | `/app/trial` route, JWT trial token | Live |
| Hiring dashboard / candidate invites | `/app/hr`, `/api/b2b/invite|candidates|assessments` | Exists in code; whether self-serve or pilot-managed is **unconfirmed** |
| Badges, leaderboard, percentiles | strings present | Exists |
| Score appeal (14 days) | rubric.html, terms.html | Published policy |
| Payments | Razorpay `/api/payment/*` | Live; prices under revision |
| ArchitectDefend / IncidentSim / ThreatBrief / ThreatHunt / VulnVerdict | names only (2–3 hits) | Unverified as working modules |
| Career Genome, Live Threat Intel feed | no app evidence | **Roadmap — remove from homepage** |

## 4. Landing page — current sections vs target

| Current section | Disposition |
|---|---|
| Nav (Home, Platform▾, InterviewPrep, Demo, Pricing, Blog, FAQ, theme, Sign in) | Rebuild to target IA |
| Hero (no CTAs — removed in round 29) | Replace → §1 Hero |
| Why it matters (4 cards) | Replace → §2 Capability gap |
| What is / IS–IS NOT | Remove (folded into §2/§3) |
| Roles marquee (15 × 3 duplicates, auto-animating) | Replace → §8 static chips |
| Assessment integrity | Move detail to security/scoring pages; §6 trust items |
| InterviewPrep orbit diagram | Replace → §3 product cards |
| Demo (static showcase + live demo) | Rebuild → §5 |
| Comparison table vs HTB/THM with **competitor prices** | **Remove** (unverified third-party pricing) |
| "Six reasons to trust" | Merge → §6 |
| "Four things only ThreatReady ships" (auto-rotating, Career Genome "Priya R.", live CVE feed) | **Remove** (roadmap features shown as live; autoplay) |
| Badges | Fold into §4 step 4 |
| Founder | Remove from homepage |
| Testimonials (6 named "Verified user") | **Remove** — unverifiable, not in target IA |
| Pricing (₹0 / ₹399 / from ₹655, multi-role discounts, Interview add-on ₹199) | Replace → §8 price-free tiles |
| Attack of the Week (6 cards, no article links) | Link from Resources only once real articles exist |
| FAQ (6 flip cards) | Replace → §9 (5 accordions) |
| Newsletter | **Remove** — form broken |
| Footer | Rebuild to target groups |
| Cookie banner | Keep (functional) |
| Auth modal (email/Google forwarding) | Keep logic; not required by new IA CTAs |

## 5. Broken at baseline (not caused by redesign)

1. **Newsletter form** posts to `formspree.io/f/YOUR_NEWSLETTER_FORM_ID` — placeholder; every submission fails.
2. **Pilot request form** posts to `formspree.io/f/YOUR_PILOT_FORM_ID` — placeholder; every B2B lead is lost and the error state shows.
3. `report-sample-b2c.html` referenced, does not exist.
4. Legal pages: `[Registered Office Address]` placeholder (privacy, terms).
5. `security.html` promises `/.well-known/security.txt` — not present.
6. Demo backend not reachable from my sandbox (proxy-blocked) — live demo **not yet verified end-to-end**.

## 6. Security findings

| # | Severity | Finding | Fix scope |
|---|---|---|---|
| S1 | High | **Model answers shipped to every visitor.** `DEMO_SCENARIOS[]` (3 scenarios) in inline JS contains `modelAnswer`; `renderScenario()` writes it into the hidden `#dScenModel` element on page load — readable in view-source/DOM before submission. | Frontend: delete `modelAnswer` from client; show only `result.model` from the evaluate response. **Backend:** evaluator receives only free-text `question` — client can submit any question text (prompt-injection / cost abuse surface). Proper fix: `GET /api/demo/scenario` → `{id, question, context}`; `POST /api/demo/evaluate {scenario_id, answer}`. Needs backend change. |
| S2 | High | **DOM XSS via AI output.** `result.feedback`, `result.model`, `result.level` are concatenated into `innerHTML`. A crafted answer that coaxes the LLM into emitting HTML executes in the threatready.io origin (CSP allows `'unsafe-inline'`). | Frontend: render with `textContent`. |
| S3 | Medium | CSP via `<meta>`: `frame-ancestors` is ignored in meta tags (clickjacking claim on security.html is not actually enforced). `'unsafe-inline'` scripts required by inline JS. GitHub Pages cannot set headers. | Move JS to external file and drop `'unsafe-inline'` for scripts; frame-ancestors needs a header-capable host/CDN (Cloudflare). |
| S4 | Medium | **Hosting claim mismatch.** Security/privacy/DPA pages state production data is in AWS Mumbai (ap-south-1). The live API is `*.onrender.com` (Render has no India region). The memory of your Oct-2026 architecture decision lists AWS Mumbai as the *V1 target*. "Data hosted in India" cannot be verified for today's backend. | Needs your confirmation before using it on the homepage. Legal pages may be making an inaccurate statement today. |
| S5 | Low | ~70 stale app bundles shipped publicly — enlarges exposed code surface and repo size (113 MB of JS). | Delete unreferenced bundles (deployment change). |
| S6 | Low | Rate limits on landing are sessionStorage-only (trivially bypassed). Security page already says server enforces — verify backend actually rate-limits `/api/demo/evaluate`. | Backend check. |
| S7 | Brand/legal | **`favicon.svg` and the bolt logo are the Vite logo** (`#863bff` path is Vite 7's default favicon). Trademark risk for a security product. | Needs a real ThreatReady mark — flagged, not changed. |

## 7. Claim verification checklist (homepage)

| Claim (from master prompt) | Verified? | Action |
|---|---|---|
| Mapped to MITRE ATT&CK | ✔ scenarios carry technique IDs | Use |
| Published scoring rubric (5 dimensions) | ✔ rubric.html | Use |
| Data hosted in India | ✖ backend on Render (S4) | **Hold until confirmed** |
| Multiple independent scoring passes; uncertainty flagged | ✔ 3-pass + confidence flags on rubric/scoring pages | Use |
| Human appeal within 14 days | ✔ rubric + terms | Use |
| 15 role tracks, Beginner→Expert | ✔ 15 named tracks + 4 levels | Use (names from site) |
| Lab Simulations | ✖ not in build | Label "Rolling out" |
| Self-service team dashboard | ? `/app/hr` exists | Use "pilot" framing only |
| Verifiable badge | ✔ public verification link per FAQ; badge code present | Use |
| No credit card for free tier | ✔ previous pricing copy | Use |
| Prices / entitlements | Under revision | **Do not publish** |
| Testimonials, comparison prices, Career Genome, live CVE feed | ✖ | Remove |
| Anthropic does not train on API data | ✔ stated on security/DPA | Use only on security page |

## 8. Proposed plan (Step B)

**Approach:** keep the static-HTML stack. Extract one shared design system and use it on every public page.

```
assets/css/tokens.css     theme tokens (dark default + light), spacing, type scale
assets/css/site.css       layout, nav, footer, buttons, cards, forms, sections
assets/js/theme.js        pre-paint theme (inline-copied in <head>), toggle
assets/js/site.js         nav dropdowns, mobile drawer, accordion, tabs
assets/js/demo.js         live demo (secured: no answers client-side, textContent rendering)
```

- `index.html` rebuilt to the 9-section IA (~70% smaller).
- Subpages re-skinned onto the shared system; legal text untouched apart from the shell.
- `legal.css` retired once all pages migrate.
- Theme toggle moves to footer; dark default; `tr-theme` key preserved so returning users keep their choice.
- All `/app/*` URLs, auth parameters, the 404/SPA redirect and `CNAME` preserved byte-for-byte.
- `/app/` build untouched.

### Decisions needed before building
1. Blueprint PDF — attach it, or proceed from the prompt's restatement.
2. "Data hosted in India" — confirm current production hosting.
3. Missing routes (pricing, product pages) — create new pages or point CTAs at existing ones.
4. Formspree IDs for the pilot form (otherwise the B2B CTA falls back to email).

---

## 9. Addendum (13 Oct 2026, 14:30): mandatory multi-page and enterprise requirements

### New findings since the first audit
- **Real product UI can be captured.** The compiled `/app/` build renders locally with a SPA fallback. With a stubbed sample account and no live data, these screens render: Lab session, difficulty levels, and InterviewPrep setup. They are now used as **genuine product screenshots**, captured in both app themes and labelled "Product screenshot". No metrics or user data appear in them.
- **S8 (High): the app bundle ships the private scenario pool.** `app/assets/index-BkpVKs77.js` contains 48 scenarios: architectures, all 5 questions each (`po[]`) and hint text (`h:`) that is close to the expected answer. Anyone can read them at `/app/assets/…js`. This is the same class of issue as S1, but in the app. It needs a source-level change (fetch scenarios per session from the API). It can't be fixed from this repo because there is no app source.
- **Confirmed free-trial entitlement** (from the app UI): 2 Beginner attempts, choosing 1–2 roles. This matches the Terms.
- **Confirmed Lab levels** (from the app UI): every level has 5 adaptive questions. Beginner takes 5–8 min with full hints, Intermediate 10–14 min with reduced hints, Advanced 12–18 min with minimal hints, Expert 15–20 min with no hints.
- **Confirmed InterviewPrep options** (from the app UI):
  - Upload a JD and/or resume (PDF, DOC or TXT, max 5 MB).
  - Session duration and difficulty: Beginner, Intermediate, Expert or Custom.
  - Modules covered: Architecture & Design, Incident Simulator, Threat Brief, Threat Hunt, Vuln Vault.

### Revised architecture: multi-page, one route per page
| Route | Purpose | Status |
|---|---|---|
| `/` index.html | Introduces the products, links out, live demo | Rebuilt (more compact) |
| `/attack-reasoning-lab.html` | Lab product page: session anatomy, levels, MITRE coverage, scoring weights | **New** |
| `/lab-simulations.html` | Simulations: in development, planned structure, preview walkthrough | **New** |
| `/interviewprep.html` | InterviewPrep: input→interview→report flow, real setup screen | **New** |
| `/pricing.html` | Plans, comparison table | Rebuilt |
| `/transparent-scoring.html` | Scoring: pipeline diagram, bands, confidence, weighting | Rebuilt |
| `/how-it-works.html` | End-to-end assessment workflow | Rebuilt (differentiated from the homepage) |
| `/resources.html` | Hub for the sample report, rubric, workflow and trust documents | **New** |
| `/contact.html` | Contact channels by purpose | **New** |
| `/pilot.html` | For Teams and pilot form | Kept |
| `/rubric.html` `/sample-report.html` `/security.html` `/privacy.html` `/terms.html` `/dpa.html` | Long-form documents | Kept |
| `/products.html` | Overview page from the first pass. It was never deployed and duplicates the 3 product pages | **Removed** |

- **Header:** Product▾ (3 pages) · For Teams · Scoring · Resources▾ · Pricing · **theme toggle** · Sign in · Start free. The theme toggle is visible at every width.
- **Footer:**
  - Product links open in the same tab.
  - **Resources, Company and Legal links and the social links open in a new tab** with `target="_blank" rel="noopener noreferrer"`.
  - The theme switch is removed from the footer.
- **Visual system upgrades:** real screenshots in browser frames, SVG technical diagrams (assessment pipeline, 3-pass scoring flow, InterviewPrep flow), a data table/heatmap of the published weighting matrix, a score-band scale, a session timeline, and the planned track × level matrix. Each product page gets its own composition.
- **Density:** section padding is tightened to 48–56 px, hero heights are capped, repeated content is removed, and each page ends with its own CTA.
