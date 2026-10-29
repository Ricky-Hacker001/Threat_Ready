# ThreatReady public site redesign: report (v2, multi-page)

Date: 13 Oct 2026. Supersedes v1. The audit and the revised architecture plan are in `docs/AUDIT.md` (§9 addendum).
Decisions from the owner: work from the prompt's restatement of the blueprint, omit the "India hosting" claim, create lean pricing and product pages, and use an email fallback for the pilot form. On top of those, the mandatory requirements A–F are applied.

## 1. What changed in v2
| Requirement | Done |
|---|---|
| **A. Multi-page** | 16 routable pages plus a 404. The homepage introduces the products and links to **three dedicated product pages**, each with its own composition. The new pages are Resources and Contact. The first-pass `products.html` overview was removed (never deployed; it duplicated the product pages). |
| **B. Header theme toggle** | An icon button in the header, visible at every width, on all 16 pages. It switches the theme instantly, persists it (`tr-theme`) and prevents a flash of the wrong theme with a head pre-paint script. The footer switch was removed. |
| **C. Footer new tabs** | All links in the Resources, Company and Legal groups, plus every social link, use `target="_blank" rel="noopener noreferrer"`. Product links stay in the same tab. `tools/check_site.py` enforces this on every page. |
| **D. Enterprise quality** | **Real product screenshots** captured from your compiled `/app` build: Lab session, difficulty levels and InterviewPrep setup, each in dark and light. Other additions: an HTML/SVG workflow pipeline, the three-pass scoring pipeline, a heatmap of the published weighting matrix, the score-band scale, a session timeline, the planned track × level matrix, a spec strip, comparison tables and a fine static grid backdrop. |
| **E. Density** | Section padding is now 56 px (40 px on mobile) and hero heights are capped. Duplicate copy was cut. Every page ends with its own CTA. Typical desktop page length is 1.3–3.1k px; the homepage is about 6k px because it has 9 mandated sections. |
| **F. Verification** | See §3. |

**How the screenshots were made.** I served `/app` locally with a sample account. API calls were stubbed with an empty profile, so no scores, users or metrics appear. Captions read "Product screenshot". The content shown is the app's own UI and its own built-in scenario text. The Lab Simulations visuals are HTML previews labelled "Preview · illustrative".

## 2. Routes
| Route | Page | Layout |
|---|---|---|
| `/` | Home | Hero with tabbed real screenshots, capability gap, 3 product cards (whole card links), 4-step pipeline, live demo + sample report, trust, organisations, roles & plans, FAQ, CTA |
| `/attack-reasoning-lab.html` | **New** | Screenshot hero, spec strip, Q1→Q5 timeline, levels screenshot + table, weighting heatmap, ATT&CK technique list |
| `/lab-simulations.html` | **New** | "In development" banner, preview walkthrough, format pipeline, planned 15×4 matrix, early-access CTA |
| `/interviewprep.html` | **New** | Screenshot hero, JD→report pipeline, module table, example question |
| `/pricing.html` | Rebuilt | Plan tiles; no prices; billing FAQ |
| `/transparent-scoring.html` | Rebuilt | Scoring pipeline, 5 dimensions, score bands and confidence table, appeal |
| `/how-it-works.html` | Rebuilt | Individual and hiring-team workflows, integrity controls |
| `/resources.html` | **New** | Hub: product evidence and trust/legal documents |
| `/contact.html` | **New** | Contact channel by need, with published response times |
| `/pilot.html` | Kept | For Teams: pilot form with email fallback |
| `/rubric.html` `/sample-report.html` `/security.html` `/privacy.html` `/terms.html` `/dpa.html` | Kept | Shared shell; body text unchanged except the sample-report corrections from v1 |
| `/404.html` | Fixed | `/app/*` SPA redirect preserved. The "not found" page now actually renders: the original wrote to `document.body` before it existed, so it was blank |

## 3. Route-by-route verification
Environment: Playwright/Chromium on a local server that behaves like GitHub Pages (`/app/*` falls back to the SPA; other unknown paths serve `404.html`). Google Fonts were blocked in testing, so the system fallback font was used.

**Tested on every one of the 16 pages, all PASS:**
- Direct load: HTTP 200.
- Refresh: 200.
- Header toggle switches the whole page to light.
- Theme persists after reload.
- A Legal footer link opens a new tab and the current page stays put.
- Every Resources, Company, Legal and social footer link has `_blank` + `noopener noreferrer`.
- Product footer links stay in the same tab.
- The header toggle is visible at 390 px.
- The mobile drawer opens, and Escape closes it.
- No horizontal overflow at 390 px.
- No console or CSP errors.

**Matrix:** 16 pages × dark/light × 1366/768/390 = **96 renders, 0 overflow, 0 errors**.

**Navigation and functions:**
| Check | Result |
|---|---|
| Home product cards → Lab / Simulations / InterviewPrep pages (whole-card click) | PASS ×3 |
| Header Product▾ → InterviewPrep; Resources▾ → Contact | PASS |
| Dropdown keyboard support (ArrowDown, arrows, Escape returns focus, outside click) | PASS |
| Hero tabs arrow-key switching, no autoplay | PASS |
| Unknown URL → 404 page; removed `products.html` → 404 | PASS |
| Live demo with a mocked API: success, score 0, no model answer, `{error}`, HTTP 500, network failure | 6/6 PASS |
| Demo request body is exactly `{question, answer}`; no model answers in client code; AI text rendered as text (XSS payload inert) | PASS |
| Pilot form: required-field validation, `?type=academic` preselect, email fallback with a copy of the request | PASS |
| `tools/check_site.py`: links, anchors, banned claims, footer new-tab, header toggle on every page | PASS |

**Not tested (assumptions):**
- A live call to `threatready-db.onrender.com`. It isn't reachable from this sandbox.
- Real sign-in and signup. The links are unchanged and statically checked.
- Voice dictation with a real microphone.
- Behaviour on actual GitHub Pages. It was emulated locally.
- Rendering with the real Inter / JetBrains Mono fonts.

## 4. Claims (two independent reviews applied)
- **v2 corrections:**
  - "verifiable badge" became "shareable badge". The only verify URL in the app points to a non-ThreatReady domain.
  - T1611 was removed from the ATT&CK list (not in the scenario pool).
  - The weighting-matrix source is no longer labelled "v1.0".
  - Confidence-level wording now matches the rubric.
  - InterviewPrep screening is framed as "through a pilot".
  - Screenshot alt text matches what is visible.
- **Kept as your mandated copy:** the hero line "…how you do the daily work…" reads as present tense although Lab Simulations isn't live. Reword it if you want strict accuracy.
- **Kept on your stated basis:** the Aerovant "cloud security and penetration-testing services" line. Your prompt called these verified. The reviewer found no public evidence in this repo.

## 5. Security
- **S1 (model answers in the landing page JS):** fixed on the frontend. The backend still needs `scenario_id`.
- **S2 (XSS from AI output):** fixed.
- **S3 (CSP):** improved. New pages allow only scripts from the site itself plus one hashed inline script.
- **S8 (new, High): `/app/assets/index-BkpVKs77.js` ships 48 private scenarios** with every question and hint text, readable by anyone. Fix it in the app source by fetching scenarios per session from the API. It can't be fixed in this repo.
- **Still open:**
  - `security.html`, `privacy.html` and `dpa.html` state AWS Mumbai hosting, but the API runs on Render.
  - ~70 stale app bundles are still in `/app/assets`.
  - The logo is Vite's mark.
  - `[Registered Office Address]` placeholder.
  - `rubric.html` header says "Version 1.0" while its own history lists v2.0.

## 6. Files (v2 delta)
- **New pages:** `attack-reasoning-lab.html`, `lab-simulations.html`, `interviewprep.html`, `resources.html`, `contact.html`.
- **New assets:** `assets/img/product/*.webp`, 6 real screenshots, 255 KB total.
- **Rebuilt:** `transparent-scoring.html`, `how-it-works.html`, plus the homepage hero, product cards and workflow.
- **Updated:** `assets/css/site.css`, `assets/js/site.js`, `tools/sync_shell.py`, `tools/check_site.py`, `404.html`, `docs/AUDIT.md`.
- **Removed:** `products.html`.

## 7. Run and deploy
```
cd Landing_Page-main
python3 -m http.server 8080          # http://localhost:8080/
python3 tools/check_site.py          # links, anchors, claims, footer new-tab, header toggle
python3 tools/sync_shell.py          # after editing nav/footer templates
```
1. Copy the files over the repository root.
2. Keep your existing `/app/` folder and `CNAME`.
3. Push. There is no build step and there are no environment variables.
4. Optional: set `FORMSPREE_ID` in `assets/js/pilot.js`, and add formspree.io to that page's CSP.
5. If you edit the pre-paint `<script>`, recompute its CSP hash.

**After deploy:**
1. Submit one live demo answer.
2. Run Sign in → Start free.
3. Open `/app/dashboard` directly; it should go through the 404 redirect.
4. Open an unknown URL; the 404 page should render.

The site is **not declared production-ready** until the live demo submission is confirmed and the hosting statements in the legal pages are corrected.

---

# v3: UI bug fixes and layout refinement (13 Oct 2026, 15:30)

## 1. Root cause: homepage click-anywhere navigation
- **The cause was `assets/css/site.css`, where v2 added a "stretched link" rule:** `.pcard-foot .link::after{content:"";position:absolute;inset:0}`. The intent was to make each product card clickable.
- **The `.pcard-foot` class was also used inside the three organisation cards** (`.card.org`). Those cards had no `position:relative`.
- **So their invisible `::after` boxes escaped the card.** They positioned against the page's initial containing block and covered the homepage. The last one in the DOM, "Start an academic pilot", sat on top.
- **Measured before the fix:** 498 of 2,376 sampled points across the homepage navigated. 336 went to `pilot.html?type=academic`, and 54 to each product page through the card-wide overlays.
- **The fix:** the stretched-link rule is deleted, not overridden. Product cards now link only through explicit elements:
  - the card title,
  - the screenshot (a real `<a>`, removed from the tab order because it duplicates the title link),
  - the "Explore …" link.
  - `tools/check_site.py` now fails the build if a `.link::after{position:absolute;inset:0}` rule comes back.
- **No JavaScript was involved.** There were no global click handlers or nested anchors.

## 2. Root cause: pointing-hand cursor on non-interactive areas
- **The cause was the same overlay.** The pointer came from the invisible anchor boxes, because browsers give links the pointing-hand cursor by default. No CSS rule sets `cursor:pointer` globally or on a wrapper.
- **The remaining `cursor:pointer` rules** are only on `.btn`, `.nav-link`, `.nav-toggle`, `.tab`, `.voice`, `.faq summary` and `.theme-btn`. All of them have working handlers or are native links.

## 3. Files modified
- `assets/css/site.css`:
  - Container width is now 1400 px with a 32 px gutter.
  - The stretched-link overlay rule is removed.
  - Section and page headings use a heading-left / lead-right grid, so there is no empty right column.
  - The hero is rebalanced.
  - The active tab has a tinted background and transitions are subtle.
  - Added the screenshot fallback style.
- `assets/css/doc.css`:
  - Long-form pages now have a sticky "On this page" rail on the left, and the content fills the remaining width. Prose is capped at 88ch for readability.
  - The document header is now two columns.
- `assets/js/site.js`:
  - Tabs update the frame URL label.
  - A screenshot that fails to load shows a text fallback, and the tabs keep working.
- `index.html`:
  - Product cards use explicit links.
  - New hero screenshot.
  - Per-tab `data-url` labels, fallbacks and updated alt text.
- `attack-reasoning-lab.html`: uses the new screenshot.
- `privacy.html`: the Anthropic privacy link now opens in a new tab.
- `assets/img/product/lab-session-{dark,light}.webp` are new. `lab-{dark,light}.webp` are removed.
- `tools/check_site.py`: new checks for external links and for the overlay rule.

## 4. Homepage image
- **Source:** your compiled `/app` build, served locally with a stubbed sample account. The scenario is the app's own "S3 Bucket Misconfiguration Chain", Intermediate, question 1 of 5.
- **Recaptured** at a 1180 px viewport and 2× resolution, so the interface text reads at hero size. The previous capture was a 1440 px screen shrunk down, so the text was tiny.
- **Same scenario in both themes**, using a seeded random pick. The old light image showed a different scenario from the dark one.
- **Cropped** to remove the half-visible submit bar.
- **Format:** 1600×829 WebP, 34 KB dark and 37 KB light. Fixed aspect ratio with `object-fit:cover`, explicit width and height to avoid layout shift, and the hidden-theme copy is lazy-loaded.
- No metrics, users or scores appear in it.

## 5. Tabs
- **What each tab shows:**
  - Reason: Lab screenshot.
  - Simulate: an HTML preview labelled "Preview · illustrative". **There is no real Lab Simulations asset because the feature isn't built.** It is documented as missing rather than shown with another product's image.
  - Interview: InterviewPrep screenshot.
- **Behaviour:**
  - Click and the arrow / Home / End keys all work.
  - ARIA tab roles and `aria-selected` are set.
  - The frame URL, image and caption update together.
  - The active state is tinted with an underline.
  - No autoplay.
  - A failed image shows a text fallback.
- **Verified at 1440 px and 390 px** with real clicks.

## 6. Whitespace corrected (measured at 1440 px)
| Page | Left edge | Median right gap |
|---|---|---|
| All marketing pages (index, the 3 product pages, pricing, pilot, scoring, how-it-works, resources, contact) | 144 → 52 px | 144 → 52 px |
| rubric, security, privacy, terms, dpa, sample-report | 144 → 52 px | **476 → 52 px** (TOC rail + full-width content) |

- Content width went from 1152 to 1336 px at a 1440 px viewport.
- The remaining large "max gaps" in the measurement are closing CTA rows, where the button sits at the right edge but isn't counted.

## 7. External links
- **Changed:** `privacy.html` → anthropic.com privacy policy. It was the only external link not opening in a new tab.
- **Already new-tab:** footer social links, Company / Resources / Legal footer groups, the Aerovant links, and the AWS documentation links.
- **Kept same-tab on purpose:**
  - `threatready.io/app/…` (Sign in, Start free): same site, part of the existing login and signup flow.
  - `mailto:` links.

## 8. Test results
- **Build:** there is no build step; the site is static HTML.
- `tools/check_site.py`: PASS. Covers links, anchors, claims, footer new-tab, all external links new-tab, header toggle and the no-overlay check.
- **Click-capture scan:** 0 points navigate outside a real link on all 16 pages at 1440 px, and on the homepage at 1920 / 768 / 390 px. Before the fix it was 498.
- **Homepage real-click suite, 31/31 PASS:**
  - 200 blank, text and image points at 1440 px and 111 at 390 px: no navigation, default cursor.
  - Clicking the hero screenshot doesn't navigate.
  - All three tabs work by mouse and keyboard.
  - Card title, screenshot and footer links navigate.
  - Card body and org-card text don't.
  - The academic pilot link still works.
  - The theme toggle works.
  - The light screenshot shows in light theme.
  - The broken-image fallback works.
- **Theme × width matrix:** 96 renders, 0 overflow, 0 console errors.
- **Route suite:** 16/16 pages pass direct load, refresh, toggle, persistence, footer new tabs, mobile drawer and 390 px fit. Navigation and 404 checks all pass.
- **Demo:** 6/6 states pass against the mocked API.
- **Interaction suite:** 20/20 pass.
- **Not tested:**
  - A live demo call and real sign-in / signup. The backend isn't reachable from the sandbox; the links and request format are unchanged.
  - Actual GitHub Pages hosting (emulated locally).
  - The real web fonts.

## 9. Remaining issues and missing assets
- **No Lab Simulations screenshot exists**, because the feature isn't built. A labelled preview is used instead.
- **No real report screenshot was captured.** It would need scored data, so the homepage uses the existing labelled sample report.
- **Still open from earlier:**
  - S8, the scenario pool shipped in the `/app` bundle.
  - The hosting statements in the legal pages (AWS Mumbai vs Render).
  - The rubric version mismatch.
  - The Vite logo.
  - The `[Registered Office Address]` placeholder.

---

# v4: hero showcase redesign and spacing fixes (13 Oct 2026, 16:30)

## What was responsible
| Area | Code | Cause |
|---|---|---|
| Hero | `index.html` `.hero` → `.frame` with `<img>` app screenshots | The full assessment screen was embedded as an image: attack chain, avatar, question, answer box, controls. |
| Hero on tablet and mobile (found while testing) | `site.css` v3 rule `.hero-grid{grid-template-columns:5fr 7fr}` | It was declared after the 1000 px media query, so it overrode it. The hero never collapsed to one column below 1000 px. |
| Roles and plans | `.split` 7fr/5fr grid; plans as three tall `.card`s; roles as wrapping chips | The right column was much taller than the 4-row chip cloud, which left a blank area under the roles. |
| Pilot form | `.split` 7fr/5fr with `align-items:start`; 2-column form | The form was 938 px tall and the aside 491 px, leaving 447 px of empty space on the right. |
| General spacing | `.section` 56 px, `.closing` 64 px, `.section-head` margin 24 px | — |

## Changes
- **Hero:** the screenshot is replaced by a composed product overview card (`.showcase`). It has a segmented tab control with Reason, Simulate and Interview.
  - **Reason:**
    - The public demo scenario (Cloud Security, Intermediate, T1078/T1537), drawn as a clean, theme-aware SVG architecture.
    - A 5-step adaptive-question progress indicator.
    - The published dimension weighting for a containment question (10/40/20/15/15, from rubric §5).
    - The report contents.
    - No question text, answers, timer or controls.
  - **Simulate:** the 4-step task format, identified-vs-missed feedback and the level progression, all labelled "In development".
  - **Interview:** job description + resume → session, the 5 real modules, and the real difficulty options.
  - All panels share one grid cell on desktop, so switching tabs never changes the card height. On mobile each panel sizes to its own content.
  - The hero now ends at 628 px on a 1366×768 laptop, so it fits above the fold.
  - The media-query order is fixed, so tablet and mobile stack correctly.
- **Roles and plans:**
  - A heading row with the level progression aligned right.
  - A 3-column role grid (2 columns on mobile).
  - A compact plan list (name + one line) whose rows stretch to match the role grid, with the pricing CTA at the bottom.
  - Section height went from 558 px to 434 px.
- **Pilot form:**
  - Inputs are now in 3 columns (2 below 1100 px), the message box sits beside the hires field, and role checkboxes are in 5 columns (3 below 1100 px).
  - "What happens next" and the Aerovant services note sit in one sticky aside.
  - The section went from 1,052 px to 722 px; the columns are now 624 vs 600 px instead of 938 vs 491.
  - All field names, ids, validation and the submission and fallback logic are unchanged.
- **Spacing:** `.section` padding is 48 px, `.closing` 40 px, and the section-head gap 16 px. Homepage length went from 5,949 px to 5,562 px.

## Files changed
- `index.html`: hero showcase, roles and plans.
- `pilot.html`: layout and its inline CSS only.
- `assets/css/site.css`: showcase component, hero media-query fix, roles and plans, spacing.

## Tests (all PASS)
- **Homepage suite, 33/33** at 1440 and 390 px:
  - The hero has no question/answer UI and no screenshot.
  - Tabs update content and selection, keep the same height on desktop, and support Home/Arrow keys.
  - Clicking the diagram doesn't navigate, and 189 and 112 blank points (1440 / 390 px) cause no navigation and show the default cursor.
  - The "Try a live scenario" and Start free targets are correct.
  - Card links, the org link and the theme toggle work.
- **Theme × width matrix:** 96 renders, 0 overflow, 0 errors.
- **Route suite:** 16/16 pages.
- **Demo states:** 6/6.
- **Interaction suite:** 20/20, including pilot validation, the academic preselect and the email fallback.
- **Click-capture scan:** index and pilot both 0 stray navigations.
- `check_site.py` OK.
- No build step.
