# ThreatReady platform — UI/UX audit (14 Oct 2026)

Scope: onboard (sign-in, home, profile, admin), InterviewPrep, Lab Simulations catalog, Attack Reasoning list and scenario pages, at 375 px (phone), ~1000 px (laptop) and wide desktop, in dark and light. The lab console is out of scope by decision: it deliberately imitates the AWS console. Method: walked every journey signed out, signed in as a learner and as an admin, plus code checks for focus, motion and token use.

Status column: **Fixed** = implemented in this pass. **Open** = recommended, not done.

## Critical

| # | Where | Problem | Why it hurts | Fix | Status |
|---|---|---|---|---|---|
| C1 | Profile overview, Attack Reasoning | AR card showed "Unavailable (HTTP 401)"; ar.threatready.io showed "Sign-in is briefly unavailable" | AR's `.env` had a different internal token and pointed identity at the wrong port, so a whole product looked broken | Re-synced `attack-reasoning/.env` (token, `IDENTITY_URL`) | Fixed |
| C2 | Header on every app below 900 px | App switcher is hidden on phones and tablets with nothing in its place | A phone user on Labs cannot reach InterviewPrep or Attack Reasoning without editing the URL. Dead end | Account menu becomes the single menu: on small screens it also lists every app | Fixed |

## High

| # | Where | Problem | Why it hurts | Fix | Status |
|---|---|---|---|---|---|
| H1 | Onboard home (`/app`) | Signed-in home is a marketing hero ("Practise the security work…"); the user's own progress lives two clicks away under Profile | Returning users can't see where they left off or what to do next | Home leads with a greeting by name and a "Continue where you left off" strip built from the overview, then the products. Profile keeps the full overview | Fixed |
| H2 | All apps | One product, three names: "Simulations" / "Attack Simulation Labs" / "Labs"; "Attack Reasoning Lab" / "Attack Reasoning"; "Interview Prep" / "InterviewPrep" | Users can't be sure they are looking at the same thing; looks unfinished | Use threatready.io's names everywhere: **InterviewPrep**, **Lab Simulations**, **Attack Reasoning Lab** | Fixed |
| H3 | Onboard header | "Home" is marked current on Profile and Admin too | Wrong location cue; screen readers announce the wrong current page | Current item follows the route | Fixed |
| H4 | Overview cards, activity list | Bare numbers like "6" next to a lab run; "Best score 6%" next to interview scores out of 100 | Ambiguous; users can't tell a score from a level or a count | Scores always read "6/100" | Fixed |
| H5 | Overview cards | Learners see transport errors ("HTTP 401", "Timed out") | Technical noise, no next step | Plain-language message with a retry; technical detail kept for the admin view | Fixed |
| H6 | Account controls | Onboard has an avatar dropdown; Labs and AR show an avatar link plus a bare "Sign out" button | Same action looks and behaves differently per app | One account menu (profile, admin for admins, sign out) in every app | Fixed |
| H7 | Admin console | "Cost per active user" divides cost in the chosen range by 7-day actives | Mixes two windows, so the number is wrong for any range but 7 days | Now "Cost per AI user": cost ÷ users with AI calls in the same range | Fixed |

## Medium

| # | Where | Problem | Fix | Status |
|---|---|---|---|---|
| M1 | InterviewPrep | Radial background gradients, glowing button shadows and gradient cards; the brand (threatready.io) is flat | Removed the decorative gradients and glows; flat surfaces with borders, same tokens | Fixed |
| M2 | Attack Reasoning list (phone) | Seven track filters wrap into four rows before any scenario is visible | Filters scroll horizontally in one row on small screens | Fixed |
| M3 | Admin (phone) | Range picker wraps raggedly into two rows | Single scrollable row | Fixed |
| M4 | Platform shell, AR, InterviewPrep room | No `prefers-reduced-motion` handling (spinners, pulses, transitions) | Global reduced-motion rule in `platform.css` and `room.css` | Fixed |
| M5 | Overview empty states | "Nothing here yet." with no way forward | Empty card offers the app's first action ("Start your first interview", "Browse labs") | Fixed |
| M6 | Loading states | Overview shows a line of text while three remote apps are queried | Skeleton cards that keep the layout stable | Fixed |
| M7 | Profile | Back link reads "All features" | "Home" | Fixed |
| M8 | Product cards (phone) | Decorative card art pushes each product's name below the fold | Art hidden below 560 px; name, description and action first | Fixed |

## Low / open

| # | Where | Recommendation | Status |
|---|---|---|---|
| L1 | Sign-in | Social sign-in sits below the password form; most users here sign in with Google/GitHub. Consider putting it first once usage data confirms it | Open |
| L2 | InterviewPrep | No light theme; it stays dark when the rest of the platform is light | Open |
| L3 | Labs console | Keeps AWS styling by decision; the transition from the catalog to the console is abrupt. A one-line "You're entering a simulated AWS console" interstitial would help | Open |
| L4 | `start-all.sh` | Piping its output (`./start-all.sh \| grep …`) keeps the pipe open; run it directly | Open |

## Validation (14 Oct 2026)

- Onboard: typecheck clean, build OK, route-permission check passes.
- InterviewPrep web: ESLint clean, typecheck clean, 38/38 tests, build OK.
- Lab Simulations: typecheck clean, 46/46 tests, build OK.
- Attack Reasoning Lab: typecheck clean, 7/7 tests, build OK.
- Browser: no horizontal overflow at 375 px and 768 px on onboard home, profile and admin, Labs, AR and InterviewPrep. The account menu lists every app on phones in all three shell apps; Enter opens it, Escape closes it and returns focus. Light and dark checked.
- Shared files (`platform.css` ×3, `shell.tsx` ×2) are identical copies.
