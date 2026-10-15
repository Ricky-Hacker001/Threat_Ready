// Homepage walkthrough: an optional tour of the interface.
// It explains where things are. It contains no scenario answers.
//
// where: 'home', or the read-only sample ticket to show ('l1', 'l2', 'l3', 'closed').
// tab:   console tab to select before pointing.
// open:  selector of something to click once so the target exists.

const t = (key) => `[data-tour~="${key}"]`;
const NEXT = 'Press Next.';

const STEPS = [
  {
    id: 'welcome', where: 'home', title: 'Welcome to the SOC simulation', focus: 'The home page',
    what: 'This application is a practice Security Operations Centre (SOC). You work a security alert the way a SOC does, from the first log line to the closed ticket.',
    why: 'This walkthrough shows where things are, so you are not lost on your first ticket.',
    how: 'Press Start. Next and Back move through the tour, "Skip this step" passes over one, and Exit leaves at any time. It takes about five minutes.',
    expect: 'Nothing is started, saved or scored by this walkthrough.',
    more: 'The walkthrough is optional. You can close it now and use the simulation straight away.',
  },
  {
    id: 'scenarios', where: 'home', title: 'Levels and entry points', focus: 'A level card under "Your levels"', target: t('home-level'), placement: 'right',
    what: 'The simulation has three levels: Foundations, Intermediate and Expert, with twelve scenarios each. "Open level" lists its scenarios; starting one creates a case and opens the console. Recent attempts further down lists everything you have started, so you can reopen it.',
    why: 'This is the normal simulation: an independent exercise where every answer is checked and scored. Passing ten scenarios in a level earns its internal badge and opens the next level.',
    how: NEXT,
    look: 'Each card shows the level state, how many scenarios you have passed and your best average.',
    expect: 'The name at the top right is the one you signed in with. It is recorded against everything done in a case.',
  },
  {
    id: 'modes', where: 'home', title: 'Normal simulation or Newbie Demo Mode', focus: 'Newbie Demo Mode card', target: t('home-demo'), placement: 'right',
    what: 'Two ways to learn. Newbie Demo Mode is a guided run from start to finish on its own sample scenario: an instructor panel points at each control, explains it, and checks your work. The normal simulation has no guidance and each answer is final.',
    why: 'If you have never worked in a SOC, do the demo first. It uses separate sample data and never changes normal cases or scores.',
    how: NEXT,
    expect: 'The demo and this walkthrough are both optional and never count towards a level.',
  },
  {
    id: 'dashboard', where: 'l1', title: 'The console: ticket bar and stage rail', focus: 'Ticket bar', target: t('topbar'), placement: 'bottom', dim: true,
    what: 'A read-only sample ticket is now open so the walkthrough has a real screen to show. Its data is simulated, it is not saved, and it is not in your attempts. The ticket bar shows the ticket number, the alert title, the severity, which tier holds the ticket and the time since the alert fired.',
    why: 'It is the session information: which case you are in and how urgent it is.',
    how: NEXT,
    look: 'Under the ticket bar, the stage rail shows the stages grouped by tier. The highlighted one is where the ticket is. Finished stages show a tick and a score.',
    expect: 'The label "Read-only sample" next to the ticket number.',
    more: 'The console has five areas, and you use the same five in every stage: ticket bar, stage rail, tabs, work area and workflow panel. Evidence is always on the left; your decisions are always on the right.',
  },
  {
    id: 'stream', where: 'l1', tab: 'feed', title: 'Event stream and log table', focus: 'Live feed toolbar and log table', target: t('feed-toolbar'), placement: 'bottom',
    what: 'The Live feed tab shows log lines as they arrive from seven sources. Each row is one event: Time (UTC), Source, Host, and the Event itself written as name=value pairs.',
    why: 'Almost everything in the feed is normal activity. The skill is finding the few lines that matter.',
    how: 'Try Pause, or switch a source off and on. Then press Next.',
    look: 'The user, the addresses, the action and the result are fields inside the Event column.',
    expect: 'New lines keep arriving at the top unless the feed is paused.',
  },
  {
    id: 'search', where: 'l1', tab: 'search', title: 'Search and filters', focus: 'Search box (Log search tab)', target: t('search-bar'), placement: 'bottom',
    what: 'Log search looks through every log on the case. Words are combined with AND, so each word you add narrows the result. field:value matches one field. The buttons underneath limit the search to one source.',
    why: 'The feed shows now. An investigation needs what happened before, and only the relevant part of it.',
    how: 'Try it: type event_id:4625 and press Search. Then press Next.',
    look: '"Query syntax" lists wildcards, exclusions and number comparisons.',
    expect: 'A count of matching events at the right, newest first.',
  },
  {
    id: 'details', where: 'l1', tab: 'alert', open: `${t('alert-matched')} ${t('row-toggle')}`, title: 'Event details and parsed fields', focus: 'An opened log line (Alert tab)', target: `${t('log-detail')} || ${t('alert-matched')}`, placement: 'top',
    what: 'The Alert tab shows the alert and the events that matched its rule. Clicking the time of a line opens it: the full raw line, then one row per field.',
    why: 'The raw line is the evidence. The parsed fields are how you search for more like it.',
    how: 'Click the time of another row to open or close it. Then press Next.',
    look: 'Each field has shortcuts: Filter, Exclude and Look up. "Show this host ±2 minutes" lists what the same computer did just before and after.',
    expect: 'In your own ticket each line also has a Pin button, and fields offer "Add indicator".',
  },
  {
    id: 'triage', where: 'l1', title: 'L1 triage and classification', focus: 'Workflow panel: triage form', target: t('workflow'), placement: 'left',
    what: 'The workflow panel holds the form for the current stage. At Tier 1 (L1) that is triage: the verdict, the severity, the evidence your decision rests on, and what should happen to the ticket.',
    why: 'Triage is the first quick decision on an alert. It decides whether specialists are needed.',
    how: 'Scroll through the questions. This sample is read-only, so nothing can be submitted. Then press Next.',
    look: 'The verdict options: false positive, benign true positive, true positive, inconclusive.',
    expect: 'A submit button at the bottom of the form.',
  },
  {
    id: 'evidence', where: 'l1', tab: 'evidence', title: 'Evidence and escalation', focus: 'Pinned events (Evidence tab)', target: t('pins'), placement: 'bottom',
    what: 'Pinning tells the simulator "this log line is my proof". Pinned lines are saved here, and they are the only things you can attach to your answers. Indicators you save are listed below them.',
    why: 'To escalate is to hand the ticket to the next tier. The same ticket moves on, and its evidence and history go with it.',
    how: NEXT,
    look: 'Each pinned event has a note box for why it matters.',
    expect: 'Two sample events are pinned here.',
  },
  {
    id: 'l2', where: 'l2', tab: 'tools', title: 'L2 investigation and validation', focus: 'Tools list (Tools tab)', target: t('tool-list'), placement: 'right',
    what: 'The same ticket, now with Tier 2 (L2). More tools are unlocked: Fleet IOC sweep, Process tree and Sandbox detonation. The form on the right asks for findings, each linked to the pinned event that shows it.',
    why: 'Tier 2 works out exactly what happened and how far it spread. A validation stage follows, where scope and severity are confirmed before any response.',
    how: NEXT,
    look: 'On the stage rail, the Tier 1 stages are ticked and Investigation is highlighted.',
    expect: 'Fleet IOC sweep, Process tree and Sandbox detonation no longer show a "Tier 2" lock.',
  },
  {
    id: 'l3', where: 'l3', title: 'L3 response and closure', focus: 'Response actions (workflow panel)', target: t('composer'), placement: 'left',
    what: 'Tier 3 (L3) is the incident responder. This panel runs response actions in five groups: containment, evidence, eradication, recovery and communication.',
    why: 'Containment cuts the attacker off. The stages after it check that the response worked and close the ticket with a final disposition and root cause.',
    how: NEXT,
    look: 'Environment state and the action log, lower in the panel, show what each action changed.',
    expect: 'Every action is simulated. Nothing outside the exercise is changed.',
  },
  {
    id: 'report', where: 'closed', tab: 'report', title: 'Case history, assessment and final report', focus: 'After-action review (report tab)', target: t('report-head'), placement: 'bottom',
    what: 'When a ticket is closed, an After-action review tab appears: an overall score, each stage marked on its own, your answers beside the expected ones with the reasons, and what actually happened. The Case history tab lists every step taken on the ticket.',
    why: 'Answers are checked while you work, but expected answers and explanations are only released at closure.',
    how: 'Open the Case history tab if you want to see the audit trail. Then press Next.',
    look: 'The buttons that download the case file.',
    expect: 'In this sample the answers and explanations are left out.',
  },
  {
    id: 'start', where: 'home', title: 'Where to start', focus: '"Start guided demo" button', target: t('home-demo-start'), placement: 'right',
    what: 'For a guided run, choose "Start guided demo". For an independent session, open Foundations and start any scenario; Foundations is the level to begin with.',
    why: 'The demo teaches the workflow. The normal simulation tests whether you can do it alone.',
    how: 'Press Finish to close the walkthrough.',
    expect: 'You are back on the home page with nothing started.',
    more: 'You can run this walkthrough again at any time from "Take a walkthrough".',
  },
];

// On console steps that point into the work area, the panel sits over the
// workflow panel so it does not cover what it is describing.
const DOCKED = ['stream', 'search', 'details', 'evidence', 'l2', 'report'];
export const HOME_TOUR = STEPS.map((s) => (DOCKED.includes(s.id) ? { ...s, dock: t('workflow') } : s));
