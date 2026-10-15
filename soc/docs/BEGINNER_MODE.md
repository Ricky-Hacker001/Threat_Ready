# Newbie Demo Mode and the homepage walkthrough: implementation report

This describes what was added to the SOC simulation, how it is kept apart
from the normal simulation, how the guided steps are validated, what was
tested, and what is limited. Everything here is in the code and was run.

## 1. What was added

Two entry points, both on the home page under "New here?". Nothing else on
the home page moved, and the normal simulation starts exactly as before.

| Entry point | Route | Purpose |
|---|---|---|
| **Newbie Demo Mode**, button "Start guided demo" | `#/demo` (start page), `#/demo/:id` (guided run), `#/demo/:id/summary` (learning summary) | Interactive, instructor-style run of one ticket from the first log line to the closed ticket, in 16 steps. |
| **How it works**, button "Take a walkthrough" | overlay on the current page | Optional 13-step tour of the interface. Starts nothing and scores nothing. |

Existing routes `#/` and `#/case/:id`, every existing API route, both
scenarios, the SSE stream, grading and scoring are unchanged.

## 2. Files

### Added

| File | What it is |
|---|---|
| `server/scenarios/demo-portal.js` | The dedicated demo scenario, `demo-portal-login`: repeated failed logons for one account followed by a success, with the same account's normal sign-ins (and one ordinary mistyped password) as the benign comparison. Hidden: never listed, cannot be started through `POST /api/cases`. |
| `server/demo/guide.js` | The 16-step script as 49 "beats" (public teaching text and arrow targets) and, separately, the server-side check for each of the 28 tasks. |
| `server/demo/service.js` | Demo sessions: start, resume, progress, skip rules, pause/exit, reset, 24-hour clean-up, and the learning summary. |
| `server/demo/autoplay.js` | Read-only sample tickets for the walkthrough, worked by the server and held in memory only. |
| `server/demo/routes.js` | `/api/demo/*` and `/api/tour/preview`. |
| `client/src/tour/GuidedTour.jsx` | The reusable tour component (see section 5). |
| `client/src/tour/bridge.js` | Small registry through which the console tells a tour how to switch tabs and read the current search and form. |
| `client/src/tour/HomeTour.jsx`, `homeTourSteps.js` | The homepage walkthrough and its 13 steps. |
| `client/src/tour/DemoIntro.jsx`, `DemoPage.jsx`, `DemoSummary.jsx`, `Quiz.jsx` | Demo start page, guided run, learning summary, and the in-step questions. |
| `client/src/tour/tour.css` | Styles for all of the above. `styles.css` is untouched. |
| `tests/demo.test.mjs` | 10 API tests for the demo and the walkthrough preview. |
| `tests/ui/*.mjs` | Four optional real-browser scripts (Playwright). Not part of `npm test`; Playwright is not a project dependency. |
| `docs/BEGINNER_MODE.md` | This report. |

### Modified (all additive)

| File | Change |
|---|---|
| `server/index.js` | Mounts the two new routers. `GET /api/cases` leaves out demo sessions. `POST /api/cases` now passes only `scenarioId` and `analyst` to the engine, so a request body cannot mark a case as a demo. |
| `server/engine/cases.js` | Optional case `kind` (`demo`, `preview`); demo ticket numbers `DEMO-…` from their own counter; in-memory store and redacted view for previews; read-only guard; three optional scenario features used only by the demo scenario: per-answer coaching (`key.coach`), answer shown after three tries (`key.reveal`), a stage that cannot be finalised with wrong answers (`noFinalize`), and a pre-submit guard (`scenario.guard`). Scenarios that define none of these behave as before. |
| `server/engine/grading.js` | A scenario may supply its own wording for a partly accepted single-event answer. Default wording unchanged. |
| `server/store.js` | Separate counter for demo ticket numbers. |
| `server/scenarios/index.js` | Hidden-scenario registry. `listScenarios()` still returns only the two assessment scenarios. |
| `client/src/App.jsx` | Three demo routes and the walkthrough overlay. |
| `client/src/Console.jsx` | The "New here?" section with the two entry points; `data-tour` attributes. |
| `client/src/CaseView.jsx` | Registers with the tour bridge; `data-tour` attributes; "Guided demo" / "Read-only sample" label; no Pin button on read-only samples. |
| `client/src/components/*.jsx` | `data-tour` attributes on stable elements. `Workflow.jsx` hides "Finalise as is" on demo stages; `ReportPanel.jsx` shows a note on demo and sample reports. |
| `client/src/api.js`, `main.jsx` | Demo API calls; import of `tour.css`. |
| `tests/s01.test.mjs` | One line: a 1.1 s wait before an existing assertion. See section 9. |
| `README.md`, `.gitignore` | Documentation; ignore UI screenshots. |

No dependency was added. No framework, build tool or storage changed.

## 3. The guided sequence

Each step is made of beats. An explanation beat can be read or skipped. A
task beat has a server check and cannot be skipped. Every beat shows: step
number and title, the name of what the arrow points at, **What**, **Why**,
**How**, the expected result, and under "Learn more" what to look for, what
happens next and extra explanation.

| Step | Beats (T = task with a server check) | Arrow target | What the server checks |
|---|---|---|---|
| 1 Introduction to the SOC environment | start page (learner presses Start); console; tiers | stage rail | A demo session exists (created by Start). |
| 2 Dashboard overview | ticket bar; tabs; workflow panel; **T** event/alert/incident/case; **T** acknowledge | ticket bar, tabs, workflow panel, Acknowledge button | Four matching answers; case status is open. |
| 3 Understanding the log table | live feed; columns; **T** select an event | feed toolbar, table header, matched events | The opened event belongs to the alert. |
| 4 Reading a raw log | raw line and fields; **T** find the fields ("Show me an example" / "Try it myself") | raw line of the open event | Four field choices, each with its own explanation when wrong. |
| 5 Search and filtering | search basics; **T** find every failed logon from the source; source filters | search bar, source buttons | The learner's query is run on the server: all 14 failures found, at most one unrelated event. Too broad, too narrow, empty, wrong source and leftover time range each get a different message. |
| 6 Normal versus suspicious | **T** compare two real patterns from the case | panel content | Three answers, including a multi-select of observations. |
| 7 Open an event and investigate | **T** open the successful logon; **T** fact sheet; look around an event | matched events, context link | The right event is open; who, from where, to what, result, and one irrelevant detail. |
| 8 L1 triage | verdict definitions; **T** threat intelligence; **T** directory and change calendar; **T** classify | verdict field, tool buttons, triage form | Tool runs recorded on the case; source, account, verdict and severity graded from the form without submitting it, with coaching per wrong choice. |
| 9 Evidence collection | **T** pin; Evidence tab; **T** attach to the decision | matched events, pinned list, Key evidence field | Pinned events cover both the failures and the success; the cited selection is graded. |
| 10 L1 escalation | **T** decide and submit; same ticket continues; **T** hand off | disposition field, stage rail, handoff form | Stage `l1_triage` then `l2_escalation` completed on the same case. |
| 11 L2 analyst workspace | what Tier 2 receives; **T** fleet sweep; **T** before and after; **T** findings | case history, tool button, search bar, investigation form | Sweep recorded; a large transfer and a normal sign-in pinned; all findings accepted and corroborated. |
| 12 L2 evidence validation | corroboration; **T** investigation summary; **T** scope and sign-off | checks field, summary field, validation form | Six parts of the summary present; stage `l2_validation` completed. |
| 13 L3 incident management | Tier 3 role; **T** contain; **T** notify; **T** declare complete | response panel, Declare button | Credentials reset and address blocked in the action log; incident lead notified; stage completed. Declaring complete before containment is refused by the server. |
| 14 Validate the response | positive and negative tests; **T** negative test; **T** positive test; **T** record | search bar, response-check form | A deny line recorded after the block is pinned; a sign-in by the real user recorded after the reset is pinned; stage completed. |
| 15 Close the case and review the report | **T** close; report; stage review; case history | closure form, report header, stage list, history | Case status is closed. |
| 16 Final learning summary | **T** open the summary | panel | Case closed; summary built on the server. |

The summary page shows what the learner did, the evidence collected, checks
passed first time and after retries, what went well, what needs improvement
and recommended next steps. It is headed "Guided learning summary" and says
it is not an assessment or certification. It offers Replay demo, Review a
specific step, Return home and Open normal simulation. It never redirects
on its own.

## 4. The homepage walkthrough

Thirteen steps, with Start, Next, Back, Skip this step, Exit, a progress
bar, a step list and Restart: welcome; scenarios and entry points; normal
simulation or Newbie Demo Mode; ticket bar and stage rail; event stream and
log table; search and filters; event details and parsed fields; L1 triage
and classification; evidence and escalation; L2 investigation and
validation; L3 response and closure; case history, assessment and final
report; where to start.

Steps 4 to 12 need a console to point at. The walkthrough says so, and
opens a **read-only sample ticket** (`SAMPLE-…`) prepared by the server at
the right stage. These live in memory, are shared, are rebuilt every 20
minutes, never appear under Cases, are never written to the case store,
and reject every change. Their view is cut back to what the alert already
shows, so touring the interface does not give away the demo: no stage
answers, no analyst notes, only pins the alert itself lists, and a report
with scores but no answers.

## 5. The reusable tour component

`GuidedTour` takes a list of step objects: `id`, `title`, `focus` (plain
text name of the target, shown as "Arrow points at …"), `target` (selector;
fallbacks separated by ` || `), `placement`, `dock`, `dim` (spotlight),
`what`, `why`, `how`, `look`, `expect`, `next`, `more`, `needs`,
`required` and `checkLabel`. The parent supplies the validation callback,
navigation, skip rule, exit menu, step list, progress and optional extra
content.

- Targets are `data-tour` attributes placed on the real controls, not
  CSS class chains.
- The highlight and arrow are measured from the live element every 200 ms
  and on scroll and resize; the target is scrolled into view once.
- The panel is placed top, bottom, left or right of the target, wherever it
  fits without covering it. When the learner must work beside the target,
  the panel docks over the opposite column so the control stays usable.
- Under 760 px the panel is a bottom sheet, the highlight is limited to
  what shows above it, and "Hide" collapses it to a bar.
- If the target is not on screen (the learner changed tab, or nothing is
  open yet) the step text stays readable and a note offers "Take me there"
  and "Try again".
- Text alternative for the arrow, a live region for check results, focus
  moved to the step heading on each step, Escape to collapse, all controls
  are buttons. Results use a mark and a word as well as colour.

## 6. How the walkthrough document was used

The attached "SOC Simulation Walkthrough Guide" was the source for
terminology, order and explanations.

| Document section | Used in |
|---|---|
| SOC basics in two minutes (tiers, word list) | Demo start page and step 1; definitions of log, alert, ticket, triage, escalate, indicator, true/false/benign positive, containment, eradication in steps 2, 8, 10, 13. |
| Know the screen (ticket bar, stage rail, tabs, work area, workflow panel) | Demo step 2; walkthrough step 4. Same five names, same "evidence on the left, decisions on the right". |
| Reading a log line and pinning it | Demo steps 3, 4, 7, 9; walkthrough steps 7 and 9. Same control names: Pin/Pinned, Filter, Exclude, Look up, Add indicator, "Show this host ±2 minutes". |
| Searching logs | Demo step 5; walkthrough step 6. |
| Scenario stages: monitor, L1 triage, L2 escalation, investigation, validation, L3 response, closure | Demo steps 2, 8 to 13 and 15, in the same order. |
| How scoring works | Demo step 15 and the summary. |

Discrepancies, resolved as follows:

1. The document walks scenarios 1 and 2 **and gives their answers**. The
   demo does not reuse them. It runs on its own scenario so that nothing
   taught in the demo is an answer to an assessment scenario.
2. The document has no "normal versus suspicious" comparison and no
   response-validation step. Demo steps 6 and 14 are new, as the
   implementation prompt requires.
3. The document says there are seven stages and that triage, escalation,
   validation and closure are single-submission. That remains true for the
   assessment scenarios. The demo scenario has eight stages (it adds
   "Response check") and lets the learner correct and resubmit.
4. The prompt lists log-table columns (destination, user, action, status,
   severity) that the interface does not have as columns. The table has
   Time, Source, Host and Event; the rest are fields inside the event. Step
   3 explains this instead of pointing at controls that do not exist.

## 7. Isolation of demo data and progress

- **Scenario**: `demo-portal-login` is used only by demo sessions and
  walkthrough samples. `GET /api/scenarios` does not list it and
  `POST /api/cases` refuses it.
- **Sessions**: a demo session is a case with `kind: 'demo'`. `/api/demo/*`
  answers 404 for anything that is not one. Ticket numbers come from a
  separate counter, so assessment ticket numbers are not consumed.
- **Lists and scores**: demo sessions are left out of `GET /api/cases`.
  Their result appears only on the demo's own report and summary.
- **Progress** is stored on the demo case (`case.demo`): current beat,
  completed and skipped beats, tries per task, last result per task,
  status (active, paused, exited, completed). A refresh or a later visit
  resumes at the same beat.
- **Reset and replay** delete that one demo case and create a clean one.
  A repeated start or reset with the same client nonce returns the same
  session, so a double click cannot create two.
- **Clean-up**: demo sessions are removed 24 hours after they start.
- All response actions are entries in the simulated action log. Nothing is
  sent or changed outside the process.

## 8. How validation works

- The browser sends what the learner did: quiz answers, the ids of open
  events, the current search, the current form values. It never sends
  "this step is complete".
- State-based tasks (acknowledge, tool runs, pins, stage submissions,
  response actions) are judged from the case on the server and ignore the
  request body.
- A task can be checked only when every earlier task has passed. Tasks
  cannot be skipped or jumped over; explanations can.
- A passed task stays passed; reviewing it later cannot undo it.
- Wrong answers get an explanation tied to the choice made. Form stages
  return the same coaching from a real submission, lock accepted answers,
  and show the answer after three tries so nobody is stuck.
- One case is not forced: if the learner disables the account instead of
  resetting it, the positive test in step 14 cannot pass. That is recorded
  as a failed test, reported under "needs improvement", and the demo
  continues.
- Answer keys, coaching text and check logic are in `server/` only. A test
  scans `client/src` and `client/dist` for them.

## 9. Tests executed

### `npm test`: 27 passed, 0 failed

17 existing tests (unchanged scenarios, SSE, search, tier gating, L1 to L3,
scoring, leak scan, restart safety) and 10 new ones:

1. The demo scenario is hidden from the normal simulation.
2. Starting a demo creates one isolated session.
3. The guide sent to the browser carries no answer material.
4. Tasks cannot be skipped, jumped over or self-certified.
5. Search, classification and form feedback coach towards the next step.
6. A full guided run reaches the learning summary.
7. The response cannot be declared complete, or verified, without doing the work.
8. Pause, resume, review, replay and reset touch only the demo session.
9. The walkthrough preview is read-only, redacted and creates no cases.
10. Frontend source and the built bundle contain no answer material.

One existing assertion in `tests/s01.test.mjs` ("no C2 traffic after
eradication") failed in 2 of about 14 runs during this work. The cause is
in the existing engine, not in the new code: log slots are one second long
and take the response state in force at the start of the slot, so a beacon
due in the same second as the last response action is still logged. This
was reproduced on purpose against the original upload (eradication run in
the same second as the next beacon: one C2 event logged 479 ms after the
actions) and behaves the same in this version. The test now waits 1.1 s
before that assertion. The assertion and the engine are unchanged. In the
simulation this means a response action takes effect in the log stream
from the next full second.

### `npm run build`: succeeded

### Real browser (Chromium, Playwright), scripts in `tests/ui/`

| Run | Viewports | Result |
|---|---|---|
| Guided demo, start to summary, including deliberate wrong answers | 1440×900, 1280×800, 390×844 | 49 of 49 beats reached; 43 of 43 targeted beats found their target with highlight and arrow; panel covered the target on 0; 27 of 27 guided checks passed; summary reached; no page errors. |
| Homepage walkthrough, 13 steps | 1440×900, 1280×800, 390×844 | 12 of 12 targeted steps highlighted with an arrow; no missing targets; number of cases before and after identical; no page errors. |
| Edge cases | 1440×900 | Double click on Start made 1 session; a task offered no Skip and 14 later steps were locked; a failed check request showed a message, kept the step, and worked on retry; leaving the tab showed the missing-target note and "Take me there" restored it; refresh resumed the same step and session; pause showed a resume card; exit then a normal shift opened an `INC-` ticket with no guide; restart gave a new session and the old one returned 404; an invalid session id showed "no longer available" on both the demo and summary routes; the walkthrough survived a refresh, restarted, exited, and the page under it stayed usable. |
| Learning summary actions | 1440×900 | No redirect after waiting; "Review a specific step" opened the chosen step with its earlier result and left the session completed; "Open normal simulation" went to the scenario list; the start page offered the finished summary; "Replay demo" started a clean session, removed the old one, and left normal cases unchanged. |
| Normal scenarios 1 and 2, start to closure, no guide opened | 1600×1000 | Both completed, with scores 99 and 100. The same script against the original upload gives the same score, history length and action count for scenario 1 (99, 56, 20). |

## 10. Limits

- **Step 14 waits on live logs.** The proof lines appear when the simulated
  attacker and user next act: up to about 40 seconds for the deny line and
  about a minute for the user's sign-in. The step says so.
- **The response-check form allows three submissions** and is then recorded
  as it stands, unlike the other demo stages. This is what lets a learner
  who disabled the account still finish.
- **The investigation summary check is by key words.** It confirms the six
  parts are present; it cannot judge the reasoning. The step says so.
- **Quiz selections are not restored after a refresh**; the verdicts are.
- **Small screens**: the instruction sheet takes the lower part of the
  screen. "Hide" is needed to reach controls under it.
- **Accessibility** was checked by keyboard and by inspecting roles and
  labels. It was not tested with a screen reader.
- **Browsers**: only Chromium was run.
- **No authentication**, as in the rest of the application. A demo session,
  like a case, is reachable by anyone who knows its id.
- The browser scripts in `tests/ui/` are not run by `npm test`.
