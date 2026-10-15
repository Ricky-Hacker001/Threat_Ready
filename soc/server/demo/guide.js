// Newbie Demo Mode: the guided script and its server-side checks.
//
// BEATS is the public script: what the learner reads and where the arrow
// points. It contains teaching text only.
// CHECKS holds what each task is validated against. It is never serialised:
// the client receives a beat id and a check label, sends back what the
// learner did, and gets a verdict and coaching in return.

import { deriveState } from '../engine/response.js';
import { gradeField, verdictOf, validateField } from '../engine/grading.js';
import { coachFor } from '../engine/cases.js';

export const STEPS = [
  'Introduction to the SOC environment',
  'Dashboard overview',
  'Understanding the log table',
  'Reading a raw log',
  'Search and filtering',
  'Normal versus suspicious activity',
  'Open an event and investigate it',
  'L1 triage',
  'Evidence collection',
  'L1 escalation',
  'L2 analyst workspace',
  'L2 evidence validation',
  'L3 incident management',
  'Validate the response',
  'Close the case and review the report',
  'Final learning summary',
];

export const INTRO = {
  title: 'Newbie Demo Mode',
  text: 'Learn how a SOC analyst investigates security events, reads logs, collects evidence, validates findings, and completes an incident through a guided, step-by-step demonstration.',
  minutes: '30 to 40',
  notes: [
    'A Security Operations Centre (SOC) watches an organisation\'s logs and reacts when something looks wrong.',
    'The work is split into three tiers. Tier 1 (L1) looks at every alert and decides whether it is real. Tier 2 (L2) works out exactly what happened. Tier 3 (L3) stops the attack and cleans up. In this demo you play all three, one after the other, on the same ticket.',
    'You will work one sample alert from the first log line to the closed ticket. An instructor panel points at each control, says what it is, why it matters and what to do, and checks your work before you move on.',
    'Everything is simulated: the company, the logs and every response action. Nothing outside this exercise is changed.',
    'This is guided practice with its own sample scenario. It is kept apart from the assessment scenarios and does not affect any score there.',
  ],
};

const t = (key, extra = '') => `[data-tour~="${key}"]${extra}`;
const fld = (id) => `[data-tour~="fld"][data-fld="${id}"]`;
const SHOWN = 'Read this, then press Next.';

// kind: 'info' is an explanation (can be skipped); 'task' needs a passed check.
export const BEATS = [
  // ---- 1 -----------------------------------------------------------------
  {
    id: '1-console', step: 1, kind: 'info', title: 'This is a practice SOC console', focus: 'The whole screen',
    what: 'A console where an analyst watches logs, investigates alerts and records decisions. The company on screen, Meridian Freight Systems, is simulated.',
    why: 'Real analysts spend the day in a screen like this. Learning where things are comes before learning what to decide.',
    how: SHOWN,
    expect: 'Nothing changes yet. Logs are already streaming on the left.',
    next: 'A quick look at how the work is split between three tiers.',
    more: 'Every log line here is synthetic and every action is simulated. No real email is sent, no real computer is touched and no real address is blocked.',
  },
  {
    id: '1-tiers', step: 1, kind: 'info', title: 'One ticket, three tiers', focus: 'Stage rail', target: t('rail'), placement: 'bottom',
    what: 'The stage rail shows the path one ticket takes: Tier 1 (L1), then Tier 2 (L2), then Tier 3 (L3). The highlighted stage is where you are.',
    why: 'The tiers exist so simple alerts are closed quickly and serious ones reach specialists. Each tier has a different job and different authority.',
    how: SHOWN,
    look: 'Tier 1: first responder, decides real or not. Tier 2: investigator, works out what happened. Tier 3: incident responder, stops the attack.',
    expect: 'The first stage, Monitor, is highlighted.',
    next: 'The areas of the screen.',
  },

  // ---- 2 -----------------------------------------------------------------
  {
    id: '2-ticketbar', step: 2, kind: 'info', title: 'Ticket bar', focus: 'Ticket bar (top of the screen)', target: t('topbar'), placement: 'bottom',
    what: 'The ticket bar shows the ticket number, the alert title, the current severity, which tier holds the ticket, and the time since the alert fired.',
    why: 'It is the session information: at any moment it tells you which case you are in and how urgent it is.',
    how: SHOWN,
    look: 'Before you acknowledge an alert it reads "No ticket yet".',
    expect: 'The label "Guided demo" marks this as a demo session.',
    next: 'The tabs and the work area.',
  },
  {
    id: '2-tabs', step: 2, kind: 'info', title: 'Tabs and work area', focus: 'Tabs above the work area', target: t('tabs'), placement: 'bottom',
    what: 'Tabs choose what the work area on the left shows: Live feed (logs as they arrive), Log search, Alert, Tools, Evidence (what you pinned) and Case history (everything done on the ticket).',
    why: 'Evidence is always on the left; your decisions are always on the right. You read on the left, then answer on the right.',
    how: SHOWN,
    expect: 'Live feed is selected and lines are arriving.',
    next: 'The workflow panel on the right.',
  },
  {
    id: '2-workflow', step: 2, kind: 'info', title: 'Workflow panel', focus: 'Workflow panel (right side)', target: t('workflow'), placement: 'left',
    what: 'The workflow panel holds the task for the current stage. Right now that is the alert queue. Later it holds the form you answer and the submit button.',
    why: 'It keeps one primary task in front of you at a time.',
    how: SHOWN,
    expect: 'An alert appears in the queue a few seconds after the session starts.',
    next: 'Five words you will see on every screen.',
  },
  {
    id: '2-terms', step: 2, kind: 'task', title: 'Event, alert, incident, case', focus: 'Short check in this panel',
    what: 'An event is one thing that happened, such as one logon attempt. A log line is the written record of an event. An alert is a detection rule noticing a pattern in events. An incident is activity confirmed as harmful that needs a response. A case (or ticket) is the file where the work is recorded.',
    why: 'Mixing these up causes real mistakes. An alert is a question, not an answer: most alerts never become incidents.',
    how: 'Match each description below to the right word, then press Check my work.',
    expect: 'All four matched.',
    next: 'You open the ticket for the alert in the queue.',
    check: { label: 'Check my work' },
  },
  {
    id: '2-ack', step: 2, kind: 'task', title: 'Acknowledge the alert', focus: '"Acknowledge and open ticket" button', target: t('ack'), placement: 'left',
    what: 'An alert is waiting in the queue. Acknowledging it says "I have this one" and opens a ticket.',
    why: 'Until someone acknowledges an alert nobody owns it. The time from alert to acknowledgement is measured in every SOC.',
    how: 'Click "Acknowledge and open ticket".',
    look: 'The alert title and the rule number, AUTH-0017.',
    expect: 'The ticket bar shows a ticket number, the Alert tab opens, and the L1 triage form appears on the right.',
    next: 'You look at how logs are laid out.',
    check: { label: 'Check', auto: true },
  },

  // ---- 3 -----------------------------------------------------------------
  {
    id: '3-feed', step: 3, kind: 'info', title: 'The live feed', focus: 'Live feed toolbar', tab: 'feed', target: t('feed-toolbar'), placement: 'bottom',
    what: 'The live feed shows log lines from seven sources as they arrive: web proxy, DNS, email, endpoint, Windows, firewall and audit.',
    why: 'Almost everything in the feed is normal activity. An analyst\'s first skill is finding the few lines that matter among thousands that do not.',
    how: 'Press Pause if the lines move too fast to read. Then press Next.',
    look: 'The buttons with source names hide or show one source. The text box shows only lines containing a word.',
    expect: 'When paused, the status reads "Paused" and counts the lines waiting.',
    next: 'The columns of the log table.',
  },
  {
    id: '3-columns', step: 3, kind: 'info', title: 'Columns of the log table', focus: 'Header row of the log table', tab: 'feed', target: t('logs-head'), placement: 'bottom',
    what: 'Time (UTC) is when the event happened. Source is the kind of system that recorded it. Host is the computer it is about. Event is the log line itself, written as name=value pairs.',
    why: 'The first three columns let you scan quickly. The detail an investigation needs is inside the Event column.',
    how: SHOWN,
    look: 'Inside Event you will find the user (user or target_user), where it came from (src_ip), where it went (dest_ip, dest_host), what was done (action, event_id) and the result (status).',
    expect: 'There is no separate column for user, action or status: they are fields inside the line.',
    next: 'You open one event to see those fields.',
    more: 'All times are in UTC so that logs from different systems and time zones line up. Severity belongs to alerts, not to single log lines; it is shown in the ticket bar and on the alert.',
  },
  {
    id: '3-open', step: 3, kind: 'task', title: 'Select an event', focus: 'Events that matched the rule (Alert tab)', tab: 'alert', target: t('alert-matched'), placement: 'top',
    what: 'The Alert tab lists the events that made the rule fire. Each row is one event.',
    why: 'Start from the events the alert points at. They are the reason the ticket exists.',
    how: 'Click the time (or the small arrow) at the left of any row in this list to open it.',
    look: 'The row expands. The full raw line appears, followed by one row per field.',
    expect: 'One event is open with its fields listed.',
    next: 'You read that event field by field.',
    check: { label: 'Check', collect: ['open'] },
  },

  // ---- 4 -----------------------------------------------------------------
  {
    id: '4-raw', step: 4, kind: 'info', title: 'The raw line and its fields', focus: 'Raw log line of the open event', tab: 'alert', target: t('raw-line'), placement: 'top', needs: 'Open an event in the Alert tab first (click its time).',
    what: 'The raw line is exactly what the system wrote: a timestamp, the system that reported it, then name=value pairs. Below it the same line is split into one row per field.',
    why: 'The raw line is the evidence. The parsed fields make it searchable.',
    how: SHOWN,
    look: 'Each field has shortcuts. Filter searches for all logs with that value. Exclude hides them. Look up checks an address against threat intelligence. Add indicator saves the value to the case.',
    expect: 'You can find the same value in the raw line and in the field list.',
    next: 'You pick out the fields that answer who, where from and what.',
  },
  {
    id: '4-fields', step: 4, kind: 'task', title: 'Find the fields that matter', focus: 'Sample log line in this panel',
    what: 'Every log answers some of these: who did it, from where, to what, what happened, and when. Each answer sits in a named field.',
    why: 'Reading the right field is what separates evidence from a guess. If you read the wrong one, every later step is built on the wrong fact.',
    how: 'Choose "Show me an example" to see a different log line explained field by field, or "Try it myself" to answer four questions about one of the failed logons.',
    look: 'Read the field name first, then its value.',
    expect: 'All four fields identified.',
    next: 'You search the logs for more events like it.',
    more: 'This check is about reading fields, not about deciding whether the activity is malicious. That decision comes later, after more evidence.',
    check: { label: 'Check my work' },
  },

  // ---- 5 -----------------------------------------------------------------
  {
    id: '5-search', step: 5, kind: 'info', title: 'Log search', focus: 'Search box (Log search tab)', tab: 'search', target: t('search-bar'), placement: 'bottom',
    what: 'Log search looks through every log on the case, not only the last few minutes. Type a query and press Search.',
    why: 'The live feed shows what is happening now. An investigation needs what happened before, and only what is relevant.',
    how: SHOWN,
    look: 'Words are combined with AND, so each word you add narrows the result. field:value matches one field. "Query syntax" lists more forms.',
    expect: 'With an empty query, every event is listed, newest first, with a count.',
    next: 'You run a search with a specific goal.',
    more: 'A search that is too broad buries the evidence under thousands of unrelated lines. A search that is too narrow hides evidence you needed. Start narrow enough to read, then check you have not cut anything out.',
  },
  {
    id: '5-task', step: 5, kind: 'task', title: 'Find every failed logon from the source address', focus: 'Search box and result count', tab: 'search', target: t('search-bar'), placement: 'bottom',
    what: 'Two fields describe the events you want: event_id is 4625 (an account failed to log on), and src_ip is the source address named in the alert.',
    why: 'The alert shows only the events that matched its rule. A search shows whether there are more, and exactly how many.',
    how: 'Type event_id:4625 src_ip: followed by the source address from the alert, with no space after the colon. Press Search. Then press Check my work.',
    look: 'The count at the right, and whether every line is a failed logon from that one address.',
    expect: 'A short list. Every line is event 4625 and every line has the same src_ip.',
    next: 'You compare this pattern with a normal one.',
    more: 'Shortcut: in an open event, click Filter next to a value to add it to the query without typing. If your result is empty, a term is misspelt or a time range is still set.',
    check: { label: 'Check my work', collect: ['search'] },
  },
  {
    id: '5-sources', step: 5, kind: 'info', title: 'Source and time filters', focus: 'Source buttons under the search box', tab: 'search', target: t('search-sources'), placement: 'bottom',
    what: 'These buttons limit the search to one log source. The number on each is how many results came from it.',
    why: 'The same activity often appears in two sources. A logon is recorded by Windows; the network connection that carried it is recorded by the firewall.',
    how: SHOWN,
    look: '"Show this host ±2 minutes" in an open event sets a time range. "Clear time range" removes it.',
    expect: 'With your current query, the results all come from the Windows source.',
    next: 'Normal activity versus suspicious activity.',
  },

  // ---- 6 -----------------------------------------------------------------
  {
    id: '6-compare', step: 6, kind: 'task', title: 'Normal or worth investigating?', focus: 'Two patterns in this panel',
    what: 'A failed logon is not suspicious by itself. People mistype passwords every day. What matters is the pattern around it.',
    why: 'If every failure were treated as an attack, the SOC would drown. If none were, attackers would walk in. Analysts compare against what normal looks like.',
    how: 'Read the two patterns below. Both come from this case\'s logs and both involve the same account. Answer the three questions, then press Check my work.',
    look: 'How many attempts, how far apart, from which address, and whether that address is a company computer.',
    expect: 'You can say which pattern is ordinary and name the observations that make the other one stand out.',
    next: 'You open the most important single event.',
    more: 'Useful questions for any pattern: how often, how fast, from where, is the source known, is the user or device unusual, and what came immediately before and after.',
    check: { label: 'Check my work' },
  },

  // ---- 7 -----------------------------------------------------------------
  {
    id: '7-open', step: 7, kind: 'task', title: 'Open the successful logon', focus: 'Events that matched the rule (Alert tab)', tab: 'alert', target: t('alert-matched'), placement: 'top',
    what: 'After the failures, the rule matched one event with event_id 4624: an account was successfully logged on.',
    why: 'Failures show someone trying. A success shows whether it worked. This one event changes how serious the alert is.',
    how: 'In this list, find the row whose Event column starts with event_id=4624 and click its time to open it. It is the newest row, at the top.',
    look: 'The src_ip of this event, compared with the src_ip of the failures.',
    expect: 'The 4624 event is open with its fields listed.',
    next: 'You write down the facts it gives you.',
    check: { label: 'Check', collect: ['open'] },
  },
  {
    id: '7-facts', step: 7, kind: 'task', title: 'State the facts', focus: 'Fact sheet in this panel',
    what: 'An investigation starts with plain facts read from the event: who, from where, to what system, and what happened.',
    why: 'Facts come before conclusions. A handoff that says "account X signed in to Y from Z at this time" can be checked by anyone.',
    how: 'Fill in the fact sheet from the open 4624 event, then press Check my work.',
    look: 'target_user, src_ip, the Host column, and the event description.',
    expect: 'Every fact accepted.',
    next: 'L1 triage: deciding what the alert is.',
    more: 'Not every field helps. Part of reading a log is knowing which details to set aside.',
    check: { label: 'Check my work' },
  },
  {
    id: '7-context', step: 7, kind: 'info', title: 'Look around an event', focus: '"Show this host ±2 minutes" link', tab: 'alert', target: t('context-link'), placement: 'top', needs: 'Open an event in the Alert tab first (click its time).',
    what: 'This link lists everything recorded for the same computer two minutes before and after the open event.',
    why: 'One event rarely explains itself. What happened just before and just after shows cause and effect.',
    how: SHOWN,
    expect: 'Clicking it opens Log search with a time range set.',
    next: 'L1 triage.',
  },

  // ---- 8 -----------------------------------------------------------------
  {
    id: '8-defs', step: 8, kind: 'info', title: 'What L1 triage decides', focus: 'Verdict question in the triage form', target: fld('verdict'), placement: 'left',
    what: 'Triage is the first quick decision on an alert: verdict, severity, and where it goes next. Tier 1 does not fix the problem; it decides what the alert is.',
    why: 'A wrong verdict either wastes specialists\' time or lets an attacker stay.',
    how: SHOWN,
    look: 'True positive: the alert is right and the activity is malicious. False positive: the rule fired on something it should not have matched. Benign true positive: the rule is right about what happened, but the activity is allowed. Inconclusive: there is not enough data to decide.',
    expect: 'You can tell the four verdicts apart.',
    next: 'You gather what the verdict needs.',
    more: 'Inconclusive is an honest answer when the data really is missing, but it is not a way to avoid deciding. If a lookup can settle it, run the lookup first.',
  },
  {
    id: '8-intel', step: 8, kind: 'task', title: 'Check the source address', focus: 'Tools tab: Threat intelligence', tab: 'tools', target: t('tool', '[data-tool="reputation"]'), placement: 'right',
    what: 'Threat intelligence says what the outside world knows about a domain, address or file: who owns it and whether it has been reported.',
    why: 'The logs tell you what an address did here. Intelligence tells you what it is.',
    how: 'Select Threat intelligence, type the source address from the alert, and press Look up.',
    look: 'The verdict, the network it belongs to, and the note about whether it is a known company address.',
    expect: 'A result card for the address appears, and the lookup is recorded in the case history.',
    next: 'You check the account and the change calendar.',
    check: { label: 'Check', auto: true },
  },
  {
    id: '8-directory', step: 8, kind: 'task', title: 'Check the account and approved work', focus: 'Tools tab: Directory and Change calendar', tab: 'tools', target: t('tool', '[data-tool="user"]'), placement: 'right',
    what: 'Directory describes an account: whose it is and where it normally signs in from. Change calendar lists approved work, such as tests and maintenance.',
    why: 'Activity that looks like an attack is sometimes approved work. You have to look for that explanation, not assume it and not ignore it.',
    how: 'Select Directory, enter the targeted account name and press Look up account. Then select Change calendar and press List changes.',
    look: 'Where the account normally signs in from, and whether any change covers the portal server today.',
    expect: 'Both results appear.',
    next: 'You record the classification.',
    check: { label: 'Check', auto: true },
  },
  {
    id: '8-classify', step: 8, kind: 'task', title: 'Classify the alert', focus: 'Triage form: source, account, verdict, severity', target: t('stage-form'), placement: 'left',
    what: 'The first four answers in the triage form: the source address, the targeted account, the verdict and the severity.',
    why: 'These four answers are the classification. Everything after it depends on them.',
    how: 'Fill in Source address, Account, Verdict and Severity from what you have found. Do not submit yet: press Check my work to have them reviewed.',
    look: 'Base each answer on something you saw: a field, a lookup result, or the absence of a change record.',
    expect: 'All four accepted. If one is not, the reason is given and you can change it.',
    next: 'You attach the evidence.',
    check: { label: 'Check my work', collect: ['form'] },
  },

  // ---- 9 -----------------------------------------------------------------
  {
    id: '9-pin', step: 9, kind: 'task', title: 'Pin the evidence', focus: 'Pin buttons in the matched events (Alert tab)', tab: 'alert', target: t('alert-matched'), placement: 'top',
    what: 'Pinning tells the simulator "this log line is my proof". Pinned lines are saved in the Evidence tab and stay with the ticket through every tier.',
    why: 'A verdict without evidence is an opinion. The next tier must be able to see what you saw.',
    how: 'Click Pin at the right of one failed logon (4625) and of the successful logon (4624). Each button changes to Pinned.',
    look: 'Required evidence: one line showing the failures and the line showing the success. Optional supporting evidence: anything that adds context, such as a normal sign-in by the same account.',
    expect: 'At least two pinned events: one failure and the success.',
    next: 'You attach them to your decision.',
    more: 'Pin what supports the decision, not everything you looked at. Unrelated pins make the case file harder to read and count against the evidence answer.',
    check: { label: 'Check', auto: true },
  },
  {
    id: '9-evidence-tab', step: 9, kind: 'info', title: 'The Evidence tab', focus: 'Pinned events (Evidence tab)', tab: 'evidence', target: t('pins'), placement: 'bottom',
    what: 'Everything you pinned, oldest first, with who pinned it. Each one has a note box for why it matters. Below are the indicators saved to the case.',
    why: 'This is the collected evidence the ticket carries forward. Notes stop the next analyst from having to guess why a line is there.',
    how: 'Optionally type a short note on a pinned event and press Save note. Then press Next.',
    expect: 'Your pinned events are listed here.',
    next: 'You select them in the triage form.',
  },
  {
    id: '9-select', step: 9, kind: 'task', title: 'Attach evidence to the decision', focus: '"Key evidence" in the triage form', target: fld('evidence'), placement: 'left',
    what: 'Key evidence lists your pinned events with a tick box each. The ones you tick are submitted as the basis for your verdict.',
    why: 'Collecting evidence and citing it are separate steps. Only cited evidence supports a decision.',
    how: 'Tick the failed logon and the successful logon under Key evidence. Then press Check my work.',
    expect: 'The evidence covers both the attempts and the success.',
    next: 'You decide where the ticket goes.',
    check: { label: 'Check my work', collect: ['form'] },
  },

  // ---- 10 ----------------------------------------------------------------
  {
    id: '10-decide', step: 10, kind: 'task', title: 'Decide and submit triage', focus: 'Disposition, note and submit button', target: fld('decision'), placement: 'left',
    what: 'Disposition is where the ticket goes: closed, kept at Tier 1, or escalated. To escalate is to hand the ticket to the next tier because it is beyond your authority or skill.',
    why: 'Tier 1 can decide what an alert is. It cannot investigate in depth or contain an attack. Knowing when to hand over is part of the job.',
    how: 'Choose a disposition, write a triage note of at least 40 characters (what you saw, where, and why you reached this verdict), then press "Submit triage decision".',
    look: 'If an answer is not accepted, a note appears under that field. Change it and submit again.',
    expect: 'The stage rail ticks L1 triage and moves to L2 escalation.',
    next: 'You prepare the handoff.',
    check: { label: 'Check', auto: true },
  },
  {
    id: '10-same-case', step: 10, kind: 'info', title: 'The same ticket continues', focus: 'Stage rail', target: t('rail'), placement: 'bottom',
    what: 'L1 triage now shows a tick and a score. The ticket number in the ticket bar has not changed.',
    why: 'Escalation hands over the same case. Evidence, notes and history go with it, so nobody starts again from nothing.',
    how: 'Optionally click the ticked L1 triage stage to review what you submitted. Then press Next.',
    expect: 'One ticket, one history, now one stage further along.',
    next: 'The handoff package.',
  },
  {
    id: '10-handoff', step: 10, kind: 'task', title: 'Hand off to Tier 2', focus: 'Handoff form', target: t('stage-form'), placement: 'left',
    what: 'The handoff package: the system involved, the indicators you can support, a priority, and a summary.',
    why: 'Tier 2 should be able to start from this package without repeating your triage.',
    how: 'Choose the system that was signed in to. Add the attacker indicator: press "Add indicator", set the type to ip and enter the source address. Choose a priority, write a summary of at least 60 characters, then press "Hand off to Tier 2".',
    look: 'An indicator (IOC) is a value that identifies the attacker, such as an address. Company addresses and account names are not attacker indicators.',
    expect: 'The stage rail moves to Tier 2, Investigation. The history records "Ticket reassigned from L1 to L2".',
    next: 'The Tier 2 workspace.',
    check: { label: 'Check', auto: true },
  },

  // ---- 11 ----------------------------------------------------------------
  {
    id: '11-workspace', step: 11, kind: 'info', title: 'What Tier 2 receives', focus: 'Case history tab', tab: 'history', target: t('history'), placement: 'top',
    what: 'The case history is the handoff: the alert, every lookup, every pinned event, the triage answers and your notes, in order.',
    why: 'A Tier 2 analyst reads this first. Whatever is missing here has to be done again.',
    how: SHOWN,
    look: 'The Evidence tab still holds what Tier 1 pinned. The Tools tab now also offers Tier 2 tools.',
    expect: 'Your triage note and escalation summary are in the list.',
    next: 'You use a Tier 2 tool.',
  },
  {
    id: '11-sweep', step: 11, kind: 'task', title: 'Correlate across sources', focus: 'Tools tab: Fleet IOC sweep', tab: 'tools', target: t('tool', '[data-tool="sweep"]'), placement: 'right',
    what: 'Fleet IOC sweep finds every host and every log source where an indicator appears. Correlation means connecting related events from different sources.',
    why: 'Tier 1 looked at logon events. The same address also appears in firewall logs, and those show what it did on the network.',
    how: 'Select Fleet IOC sweep, enter the source address, and press Run sweep.',
    look: 'Which sources mention the address, the first and last time it was seen, and how many events there are.',
    expect: 'A table of where the address appears, with the earliest matching events below it.',
    next: 'You find what happened after the success.',
    check: { label: 'Check', auto: true },
  },
  {
    id: '11-correlate', step: 11, kind: 'task', title: 'Find the before and the after', focus: 'Log search', tab: 'search', target: t('search-bar'), placement: 'bottom',
    what: 'Two more pieces of evidence: what the address did after the successful logon, and what this account\'s normal sign-in looks like.',
    why: 'A related event is one that shares something with the activity: the same address, the same account, the same time. An unrelated event shares nothing but the screen.',
    how: 'Search for src_ip: followed by the source address, then bytes>1000000 to keep only large transfers. Pin one of the firewall lines it finds. Then search event_id:4624 host:WEB01 target_user:*r.delgado and pin one sign-in that came from her own workstation.',
    look: 'In the firewall lines: the time, compared with the successful logon, and the bytes field. In her normal sign-ins: the src_ip and auth_package fields.',
    expect: 'Two new pinned events: one showing the address after the success, one showing the account\'s normal sign-in.',
    next: 'You record the findings.',
    more: 'Order matters. The sequence here is: normal sign-ins, then the failures, then the success, then the activity that followed.',
    check: { label: 'Check', auto: true },
  },
  {
    id: '11-findings', step: 11, kind: 'task', title: 'Record the investigation findings', focus: 'Investigation form', target: t('stage-form'), placement: 'left',
    what: 'Five findings. Four of them need a pinned event linked as proof.',
    why: 'Tier 2 states what the evidence supports, one finding at a time, each tied to the log line that shows it.',
    how: 'Answer each finding. Under each one, click "Link supporting evidence" and tick the pinned event that shows it. Press "Submit findings for review".',
    look: 'Accepted findings lock. For the others a note says what to check. "Accepted, not corroborated" means the answer is right but the linked event does not show it.',
    expect: 'All findings accepted and corroborated. The stage rail moves to Validation.',
    next: 'Validation.',
    check: { label: 'Check', auto: true },
  },

  // ---- 12 ----------------------------------------------------------------
  {
    id: '12-checks', step: 12, kind: 'info', title: 'Corroboration', focus: '"Corroboration performed" in the validation form', target: fld('checks'), placement: 'left',
    what: 'This list is filled in from the tools you have run. It shows which independent sources back your conclusion.',
    why: 'A conclusion is validated when sources that do not depend on each other agree: the logs, outside intelligence, the directory and the change record.',
    how: 'If an item is not ticked, run that tool now from the Tools tab. Then press Next.',
    look: 'Confirmed fact: something a log line or lookup shows. Assumption: something that seems likely but nothing shows.',
    expect: 'All three ticked.',
    next: 'The investigation summary.',
  },
  {
    id: '12-summary', step: 12, kind: 'task', title: 'Write the investigation summary', focus: '"Investigation summary" box', target: fld('summary'), placement: 'left',
    what: 'A short written account for incident response. It should let someone act without reading the whole case.',
    why: 'Tier 3 will take action on real systems based on this text. Anything unsupported in it becomes someone else\'s mistake.',
    how: 'Write at least 100 characters covering: what happened, why it is malicious or benign, the evidence, the likely cause, the impact, and what is still not known. Then press Check my work.',
    look: 'State only what you can point to. Say plainly what you could not confirm.',
    expect: 'The automatic check finds each of the six parts.',
    next: 'You sign off.',
    more: 'The automatic check looks for the parts of a good summary by key words. It cannot judge whether your reasoning is right; a human reviewer would.',
    check: { label: 'Check my work', collect: ['form'] },
  },
  {
    id: '12-signoff', step: 12, kind: 'task', title: 'Confirm scope and sign off', focus: 'Validation form and submit button', target: t('stage-form'), placement: 'left',
    what: 'The rest of the validation form: what is confirmed, the order of events, the validated severity, and the decision.',
    why: 'Scope decides the response. Claim too little and the attacker keeps access; claim too much and the business loses systems it did not need to lose.',
    how: 'Answer the remaining questions. Put the events in order with the arrow buttons. Press "Sign off validation".',
    look: 'Choose the scope the evidence shows, not the worst case you can imagine.',
    expect: 'The stage rail moves to Tier 3, L3 response.',
    next: 'Incident response.',
    check: { label: 'Check', auto: true },
  },

  // ---- 13 ----------------------------------------------------------------
  {
    id: '13-role', step: 13, kind: 'info', title: 'What Tier 3 does', focus: 'Response actions panel', target: t('composer'), placement: 'left',
    what: 'Tier 3 is the incident responder. This panel runs response actions: containment, evidence, eradication, recovery and communication.',
    why: 'Containment means cutting the attacker off. Eradication removes what they left. Recovery returns things to normal. Communication tells the people who must know.',
    how: SHOWN,
    look: 'Each action has a target. Actions on important servers ask for confirmation because they interrupt the business.',
    expect: 'No action has been run yet.',
    next: 'You contain the incident.',
    more: 'Every action in this panel is simulated. It changes the simulated environment and the logs that follow, and nothing else.',
  },
  {
    id: '13-contain', step: 13, kind: 'task', title: 'Cut the attacker off', focus: 'Action, Target and "Execute action"', target: t('composer'), placement: 'left',
    what: 'Two containment actions fit what Tier 2 confirmed: make the stolen password useless, and stop the address reaching the portal.',
    why: 'Blocking the address alone is not enough, because an attacker can change address in seconds. The password is what they really hold.',
    how: 'Choose "Reset credentials", select the affected account, press Execute action. Then choose "Block IP address", enter the source address, press Execute action.',
    look: 'Environment state and the action log below update after each action.',
    expect: 'The account shows "Credentials reset" and the address shows as blocked.',
    next: 'You tell the people who need to know.',
    more: 'Match the action to the confirmed scope. Isolating or rebuilding the portal server would take a business service offline for a problem the evidence does not show.',
    check: { label: 'Check', auto: true },
  },
  {
    id: '13-notify', step: 13, kind: 'task', title: 'Notify', focus: 'Action: Notify stakeholder', target: t('composer'), placement: 'left',
    what: 'The Communication action sends an incident notification to a stakeholder.',
    why: 'The incident lead owns the response and must know. The affected user needs to know her password was guessed.',
    how: 'Choose "Notify stakeholder", select "CISO / incident response lead", press Execute action. Optionally notify the affected user and line manager too.',
    look: 'Customers, the press and regulators are not told at this point. That is a later decision for legal and the incident lead.',
    expect: 'Environment state lists who was notified.',
    next: 'You declare the response complete.',
    check: { label: 'Check', auto: true },
  },
  {
    id: '13-declare', step: 13, kind: 'task', title: 'Declare the response complete', focus: '"Declare response complete" button', target: t('declare'), placement: 'left',
    what: 'This button locks the response actions and moves the ticket on.',
    why: 'A response has a defined end, after which someone checks that it worked.',
    how: 'Press "Declare response complete", then "Confirm, response is complete".',
    expect: 'The stage rail moves to Response check.',
    next: 'You prove the response worked.',
    check: { label: 'Check', auto: true },
  },

  // ---- 14 ----------------------------------------------------------------
  {
    id: '14-why', step: 14, kind: 'info', title: 'Running an action is not proof', focus: 'Response check form', target: t('wf-head'), placement: 'left',
    what: 'Two kinds of test. A negative test confirms that the prohibited activity now fails. A positive test confirms that approved activity still works.',
    why: 'A block that was typed wrong blocks nothing. A reset that locked out the real user has caused a second problem. Only the logs show which happened.',
    how: SHOWN,
    look: 'The logs are still streaming. The outside address keeps trying about every 35 seconds, and the real user signs in about once a minute.',
    expect: 'New log lines recorded after your actions show the result.',
    next: 'The negative test.',
  },
  {
    id: '14-negative', step: 14, kind: 'task', title: 'Negative test: the attacker is refused', focus: 'Log search', tab: 'search', target: t('search-bar'), placement: 'bottom',
    what: 'A firewall line with action=deny for the outside address shows the block working.',
    why: 'This is the prohibited activity being attempted again and failing.',
    how: 'Search for src_ip: followed by the source address, then action:deny. Pin one result. If there are no results yet, wait half a minute and press Search again.',
    look: 'action=deny and the rule name on the line.',
    expect: 'One pinned firewall line, recorded after your block, showing the address being refused.',
    next: 'The positive test.',
    check: { label: 'Check', auto: true },
  },
  {
    id: '14-positive', step: 14, kind: 'task', title: 'Positive test: the real user can still work', focus: 'Log search', tab: 'search', target: t('search-bar'), placement: 'bottom',
    what: 'A successful logon (4624) for the same account from her own workstation, recorded after the reset.',
    why: 'Containment that stops the business is a failure of a different kind.',
    how: 'Search for event_id:4624 host:WEB01 target_user:*r.delgado. Pin the newest result that comes from her workstation. If the newest one is older than your reset, wait a minute and search again.',
    look: 'src_ip is her workstation, and the time is after your reset.',
    expect: 'One pinned sign-in from her workstation recorded after the reset.',
    next: 'You record the validation.',
    check: { label: 'Check', auto: true },
  },
  {
    id: '14-record', step: 14, kind: 'task', title: 'Record the validation', focus: 'Response check form', target: t('stage-form'), placement: 'left',
    what: 'The form asks for your two proofs and for the risk that remains.',
    why: 'Containment stops further access. It does not undo what already happened, and the case file must say so.',
    how: 'Choose the deny line as proof the attacker is locked out, choose the new sign-in as proof the user can still work, select the remaining risks the evidence supports, and press "Record validation".',
    look: 'This form allows three submissions. After the third it is recorded as it stands.',
    expect: 'The stage rail moves to Closure.',
    next: 'Closure.',
    check: { label: 'Check', auto: true },
  },

  // ---- 15 ----------------------------------------------------------------
  {
    id: '15-close', step: 15, kind: 'task', title: 'Close the ticket', focus: 'Closure form', target: t('stage-form'), placement: 'left',
    what: 'The closure form: final disposition, root cause, recommendations and a short summary.',
    why: 'A closed ticket is a record. Months later it is how someone learns what happened and what was changed because of it.',
    how: 'Answer the four questions and press "Close ticket".',
    look: 'Root cause is the weakness that let it happen, not the attacker\'s action. Recommendations should be in proportion to what happened.',
    expect: 'The ticket closes and the After-action review tab opens.',
    next: 'The report.',
    check: { label: 'Check', auto: true },
  },
  {
    id: '15-report', step: 15, kind: 'info', title: 'The after-action review', focus: 'Report header and score', tab: 'report', target: t('report-head'), placement: 'bottom',
    what: 'The report for the closed ticket: an overall figure out of 100, times, and each stage marked on its own.',
    why: 'Feedback is how the next ticket goes better.',
    how: SHOWN,
    look: 'In this demo the figure is a guided-learning result. You were coached and could retry, so it is not an assessment or a certification.',
    expect: 'A score, a band and four time measurements.',
    next: 'The stage-by-stage review.',
  },
  {
    id: '15-review', step: 15, kind: 'info', title: 'Stage-by-stage review', focus: 'Scoring by stage', tab: 'report', target: t('report-stages'), placement: 'top',
    what: 'Each stage opens to show, for every answer: what you answered, what was expected, and why.',
    why: 'The "why" is the part to read. It ties each expected answer to the evidence.',
    how: 'Open a stage by clicking its name. Then press Next.',
    look: 'Further down, "What actually happened" tells the whole story in order.',
    expect: 'Stages you answered first time show 100%. Stages you retried show less.',
    next: 'The case file.',
  },
  {
    id: '15-history', step: 15, kind: 'info', title: 'The complete case history', focus: 'Case history tab', tab: 'history', target: t('history'), placement: 'top',
    what: 'Every step from the alert firing to the ticket closing, in order: lookups, evidence, decisions, actions and notes.',
    why: 'This is the audit trail. It can be downloaded from the report as a case file.',
    how: SHOWN,
    expect: 'The first entry is the start of the session; the last is the ticket closing.',
    next: 'Your learning summary.',
  },

  // ---- 16 ----------------------------------------------------------------
  {
    id: '16-summary', step: 16, kind: 'task', title: 'Open your learning summary', focus: 'This panel',
    what: 'A summary of what you did in this demo: the evidence you collected, the checks you passed first time, the ones that took more tries, and what to practise next.',
    why: 'Knowing which steps needed a second try tells you what to practise.',
    how: 'Press "Open learning summary".',
    expect: 'The summary opens. From there you can replay the demo, review a step, return home, or open the normal simulation.',
    next: 'Nothing happens automatically. You choose where to go.',
    check: { label: 'Open learning summary' },
  },
];

// While the learner reads or works in the left-hand work area, the
// instruction panel sits over the workflow panel on the right so that it
// never covers the logs, the search box or the tools.
const WORK_AREA = ['3-feed', '3-columns', '3-open', '4-raw', '5-search', '5-task', '5-sources', '7-open', '7-context', '8-intel', '8-directory', '9-pin', '9-evidence-tab', '11-workspace', '11-sweep', '11-correlate', '14-negative', '14-positive', '15-report', '15-review', '15-history'];
for (const b of BEATS) if (WORK_AREA.includes(b.id)) b.dock = t('workflow');

export const beatIndex = new Map(BEATS.map((b, i) => [b.id, i]));

// ---------------------------------------------------------------------------
// Server-side helpers for the checks
// ---------------------------------------------------------------------------
const tagsOf = (stream, id) => stream.get(id)?._tags || [];
const pinHas = (ctx, tags) => ctx.c.pins.some((p) => tagsOf(ctx.stream, p.eventId).some((x) => tags.includes(x)));
const ran = (c, tool, test) => c.toolRuns.some((r) => r.tool === tool && (!test || test(r.input)));
const stageOrder = (ctx) => ctx.scn.stages.map((s) => s.id);
// True once the ticket has moved beyond the named stage.
const past = (ctx, id) => ctx.c.status === 'closed' || stageOrder(ctx).indexOf(ctx.c.stage) > stageOrder(ctx).indexOf(id);
const sameIp = (v, ip) => String(v || '').trim() === ip;
// A pinned sign-in by the real user from her workstation, but to some other server.
const otherServerPin = (ctx) => ctx.c.pins.map((p) => p.snapshot).find((e) => String(e.fields.event_id) === '4624' && e.fields.src_ip === ctx.scn.facts.WS_IP && e.host !== ctx.scn.facts.WEB && cleanUser(e.fields.target_user) === ctx.scn.facts.USER);
const cleanUser = (v) => String(v || '').trim().toLowerCase().replace(/^meridian\\/, '');
const ok = (message) => ({ ok: true, message });
const no = (message, items) => ({ ok: false, message, ...(items ? { items } : {}) });

// Grade part of a form as the learner has it now, without submitting it.
function reviewFields(ctx, stageId, ids) {
  const def = ctx.scn.stages.find((s) => s.id === stageId);
  const values = ctx.data?.form?.values || ctx.c.stages[stageId]?.draft?.values || {};
  return ids.map((id) => {
    const f = def.fields.find((x) => x.id === id);
    const locked = ctx.c.stages[stageId]?.fields?.[id]?.locked;
    const value = locked ? ctx.c.stages[stageId].fields[id].value : values[id];
    const problem = validateField(f, value);
    if (problem) return { id, label: f.label, ok: false, message: 'Not answered yet.' };
    const g = gradeField(f, value, { stream: ctx.stream, case: ctx.c });
    const v = verdictOf(g.credit);
    if (v === 'correct') return { id, label: f.label, ok: true, message: 'Accepted.' };
    return { id, label: f.label, ok: false, message: [g.detail, coachFor(f, value) || f.key.hint].filter(Boolean).join(' ') || 'Not accepted. Check it against the evidence.' };
  });
}

function reviewQuiz(spec, answers = {}) {
  const items = spec.map((q) => {
    const a = answers[q.id];
    if (a === undefined || a === null || a === '' || (Array.isArray(a) && !a.length)) return { id: q.id, ok: false, message: 'Not answered yet.' };
    if (q.test) {
      const good = q.test(a);
      return { id: q.id, ok: good, message: good ? q.right : (q.wrong?.(a) || q.fallback) };
    }
    if (Array.isArray(q.answer)) {
      const want = new Set(q.answer);
      const got = new Set(a);
      const extra = [...got].filter((x) => !want.has(x));
      const missing = [...want].filter((x) => !got.has(x));
      if (!extra.length && !missing.length) return { id: q.id, ok: true, message: q.right };
      const parts = extra.map((x) => q.why?.[x]).filter(Boolean);
      if (missing.length) parts.push(`${missing.length} observation${missing.length === 1 ? ' that matters is' : 's that matter are'} not selected.`);
      return { id: q.id, ok: false, message: parts.join(' ') || q.fallback };
    }
    const good = String(a) === q.answer;
    return { id: q.id, ok: good, message: good ? q.right : (q.why?.[a] || q.fallback) };
  });
  return items;
}
const quizResult = (items, pass, fail) => (items.every((i) => i.ok) ? { ok: true, message: pass, items } : { ok: false, message: fail, items });

// ---------------------------------------------------------------------------
// Widgets (what a task shows inside the panel). Built per case from its
// own logs; question text and options only.
// ---------------------------------------------------------------------------
const WORDS = [
  { value: 'event', label: 'Event (one log line)' },
  { value: 'alert', label: 'Alert' },
  { value: 'incident', label: 'Incident' },
  { value: 'case', label: 'Case (ticket)' },
];
const byTag = (stream, tag) => stream.events.filter((e) => (e._tags || []).includes(tag));
const pub = (e) => ({ id: e.id, ts: e.ts, source: e.source, host: e.host, raw: e.raw, fields: e.fields });
// The newest failed logon in the burst. It is in the history from the start
// of the session, so the widget does not depend on the alert having fired.
const lastMatchedFail = (ctx) => byTag(ctx.stream, 'atk_fail').slice(-1)[0];

const FW_MEANING = {
  action: ['What the firewall did with the connection.', 'allow means the connection happened; deny means it was stopped.', 'Look for a matching event on the destination system.'],
  src_ip: ['The address that started the connection.', 'It identifies where the activity came from.', 'Look it up in Asset inventory, or in Threat intelligence if it is not internal.'],
  src_host: ['The computer name for that address, when it is a company computer.', 'A name here means the source is a known asset.', 'Check the owner in Asset inventory.'],
  src_port: ['A temporary number the source computer picked for this connection.', 'Rarely matters. It only tells two connections apart.', 'No check needed.'],
  dest_ip: ['The address the connection went to.', 'It shows what was reached.', 'Look it up in Asset inventory.'],
  dest_host: ['The computer name for the destination.', 'It tells you which system was accessed.', 'Check its role in Asset inventory.'],
  dest_port: ['The service that was contacted. 443 is HTTPS, a web site.', 'It shows what kind of access this was.', 'Compare with the role of the destination.'],
  proto: ['The network protocol.', 'Rarely matters for a first reading.', 'No check needed.'],
  zone: ['Which network areas the connection crossed, from -> to.', 'It shows whether the source was inside the company or on the internet.', 'Compare with the source address.'],
  rule: ['The firewall rule that matched.', 'It shows whether this path is expected and allowed.', 'Compare with other lines that use the same rule.'],
  bytes: ['How much data was transferred.', 'Unusually large transfers can show data being taken.', 'Compare with other transfers by the same source.'],
};

const WIDGETS = {
  '2-terms': () => ({
    type: 'quiz',
    questions: [
      { id: 'q1', kind: 'single', prompt: 'A server records one failed logon attempt as a single line.', options: WORDS },
      { id: 'q2', kind: 'single', prompt: 'A detection rule notices many failed logons followed by a success and raises a notice in the queue.', options: WORDS },
      { id: 'q3', kind: 'single', prompt: 'The file with a ticket number where every lookup, decision and note is recorded.', options: WORDS },
      { id: 'q4', kind: 'single', prompt: 'After investigation, the activity is confirmed as harmful and a response is needed.', options: WORDS },
    ],
  }),
  '4-fields': (ctx) => {
    const ev = lastMatchedFail(ctx);
    const ex = byTag(ctx.stream, 'legit_net')[0];
    if (!ev) return null;
    const names = Object.keys(ev.fields).filter((k) => k !== 'source').map((k) => ({ value: k, label: k }));
    return {
      type: 'quiz',
      event: pub(ev),
      eventTitle: 'One of the failed logons that matched the rule',
      modes: true,
      example: ex ? {
        title: 'Example: a firewall line, field by field',
        raw: ex.raw,
        rows: Object.entries(ex.fields).filter(([k]) => FW_MEANING[k]).map(([k, v]) => ({ field: k, value: String(v), meaning: FW_MEANING[k][0], matters: FW_MEANING[k][1], verify: FW_MEANING[k][2] })),
      } : null,
      questions: [
        { id: 'who', kind: 'single', prompt: 'Which field names the account someone tried to sign in as?', options: names },
        { id: 'from', kind: 'single', prompt: 'Which field shows the address the attempt came from?', options: names },
        { id: 'what', kind: 'single', prompt: 'Which field holds the number that says what kind of event this is?', options: names },
        { id: 'result', kind: 'single', prompt: 'Which field says in words why the logon did not succeed?', options: names },
      ],
    };
  },
  '6-compare': (ctx) => {
    const typo = byTag(ctx.stream, 'legit_typo')[0];
    const legit = byTag(ctx.stream, 'legit').find((e) => typo && e.ts > typo.ts);
    const fails = byTag(ctx.stream, 'atk_fail');
    const success = byTag(ctx.stream, 'atk_ok')[0];
    if (!typo || !legit || !fails.length || !success) return null;
    const gap = Math.round((fails[1].ts - fails[0].ts) / 1000);
    const F = ctx.scn.facts;
    return {
      type: 'quiz',
      panels: [
        {
          title: 'Pattern A',
          facts: [['Failed logons before the success', '1'], ['Time from failure to success', `${Math.round((legit.ts - typo.ts) / 1000)} seconds`], ['Source address', `${typo.fields.src_ip} (${F.WS}, a company workstation)`], ['Sign-in method', typo.fields.auth_package]],
          events: [pub(typo), pub(legit)],
        },
        {
          title: 'Pattern B',
          facts: [['Failed logons before the success', String(fails.length)], ['Time between attempts', `about ${gap} seconds, every time`], ['Source address', `${fails[0].fields.src_ip} (not in the asset inventory)`], ['Sign-in method', fails[0].fields.auth_package]],
          events: [pub(fails[0]), pub(fails[fails.length - 1]), pub(success)],
          note: `First and last of ${fails.length} failures, then the success.`,
        },
      ],
      questions: [
        { id: 'typo', kind: 'single', prompt: 'Which pattern looks like a person who mistyped a password and then got it right?', options: [{ value: 'a', label: 'Pattern A' }, { value: 'b', label: 'Pattern B' }] },
        { id: 'inv', kind: 'single', prompt: 'Which pattern needs to be investigated?', options: [{ value: 'a', label: 'Pattern A' }, { value: 'b', label: 'Pattern B' }, { value: 'both', label: 'Both equally' }, { value: 'none', label: 'Neither' }] },
        {
          id: 'obs', kind: 'multi', prompt: 'Which observations make that pattern stand out? Select every one that applies.',
          options: [
            { value: 'count', label: 'Many failures in a row for one account' },
            { value: 'name', label: 'The account name appears in the events' },
            { value: 'pace', label: 'The attempts are evenly spaced, a few seconds apart' },
            { value: 'server', label: 'The events were recorded on a server' },
            { value: 'source', label: 'The source address is not a company computer' },
            { value: 'top', label: 'The events are nearer the top of the list' },
          ],
        },
      ],
    };
  },
  '7-facts': (ctx) => {
    const ev = byTag(ctx.stream, 'atk_ok')[0];
    if (!ev) return null;
    return {
      type: 'quiz',
      event: pub(ev),
      eventTitle: 'The successful logon that matched the rule',
      questions: [
        { id: 'who', kind: 'text', prompt: 'Who: which account signed in?', placeholder: 'account name' },
        { id: 'from', kind: 'text', prompt: 'From where: which address did the sign-in come from?', placeholder: 'IPv4 address' },
        { id: 'to', kind: 'single', prompt: 'To what: which system was signed in to?', options: ['WEB01', 'WS-SAL-007', 'DC01', 'FW01'].map((v) => ({ value: v, label: v })) },
        { id: 'result', kind: 'single', prompt: 'What happened?', options: [{ value: 'failed', label: 'The logon failed' }, { value: 'ok', label: 'The logon succeeded' }, { value: 'locked', label: 'The account was locked out' }] },
        { id: 'noise', kind: 'single', prompt: 'Which of these details does not help you judge the event?', options: [{ value: 'src_ip', label: 'src_ip (the source address)' }, { value: 'auth_package', label: 'auth_package (the sign-in method)' }, { value: 'logon_id', label: 'logon_id (the session number)' }, { value: 'workstation', label: 'workstation (the name the source gave)' }] },
      ],
    };
  },
};

export function widgetFor(beat, ctx) {
  const build = WIDGETS[beat.id];
  if (!build) return undefined;
  try { return build(ctx) || undefined; } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Checks. One function per task beat. ctx = { c, scn, stream, data, st }.
// ---------------------------------------------------------------------------
const TERMS = [
  { id: 'q1', answer: 'event', right: 'One line recording one thing that happened is an event.', why: { alert: 'An alert is raised by a rule that looks at many events. This is a single recorded attempt.', incident: 'An incident is confirmed harm. One failed logon is only something that happened.', case: 'A case is the file for the work. This is one line a server wrote.' }, fallback: 'Read the definitions above again.' },
  { id: 'q2', answer: 'alert', right: 'A rule noticing a pattern is an alert.', why: { event: 'An event is one thing that happened. Here a rule looked at many events and noticed a pattern.', incident: 'Not yet. Nobody has confirmed the pattern is harmful.', case: 'The case is the file opened to work on it.' }, fallback: 'Read the definitions above again.' },
  { id: 'q3', answer: 'case', right: 'The file that records the work is the case, or ticket.', why: { event: 'An event is one logged thing. This is where the work is written down.', alert: 'The alert is what caused the file to be opened.', incident: 'An incident is the confirmed problem. The file exists whether or not the alert turns out to be one.' }, fallback: 'Read the definitions above again.' },
  { id: 'q4', answer: 'incident', right: 'Confirmed harm that needs a response is an incident.', why: { event: 'An event is one logged thing. This describes a confirmed problem.', alert: 'An alert is the question. This is the answer after investigation.', case: 'The case is the file. The confirmed problem recorded in it is the incident.' }, fallback: 'Read the definitions above again.' },
];
const FIELDS_Q = [
  { id: 'who', answer: 'target_user', right: 'target_user is the account the logon was attempted for.', why: { workstation: 'workstation is the computer name the source gave, not the account.', host: 'host is the server that recorded the event.' }, fallback: 'Look for the field whose value contains an account name.' },
  { id: 'from', answer: 'src_ip', right: 'src_ip is the address the attempt came from.', why: { host: 'host is the server that recorded the event: where the attempt arrived, not where it came from.', workstation: 'workstation is a name the source computer reports about itself. It can be anything. The address is in another field.' }, fallback: 'Look for the field whose value is an IP address.' },
  { id: 'what', answer: 'event_id', right: 'event_id is the event type. 4625 always means an account failed to log on.', why: { event: 'event holds the description in words. The question asks for the number.', status: 'status is a result code for this attempt. The event type is a different field.', logon_type: 'logon_type says how the logon was made (3 means over the network), not what kind of event this is.' }, fallback: 'Look for the field with a four-digit number.' },
  { id: 'result', answer: 'failure_reason', right: 'failure_reason gives the cause in words.', why: { status: 'status holds the same result as a code. The question asks for the field that says it in words.', event: 'event says that a logon failed, but not why.' }, fallback: 'Look for the field whose value is a sentence about the password.' },
];
const COMPARE_Q = [
  { id: 'typo', answer: 'a', right: 'One failure, then a success a few seconds later, from her own workstation: an ordinary mistake.', why: { b: 'Count the failures in pattern B, and look at how evenly they are spaced. A person does not type like that.' }, fallback: '' },
  { id: 'inv', answer: 'b', right: 'Pattern B is the one to investigate.', why: { a: 'Pattern A is one mistyped password from a company workstation. That happens all day.', both: 'They are not equal. Compare how many attempts there are and where they come from.', none: 'Look at pattern B again: many failures, evenly spaced, from an address that is not a company computer, then a success.' }, fallback: '' },
  { id: 'obs', answer: ['count', 'pace', 'source'], right: 'How many, how fast, and from where: those three set pattern B apart.', why: { name: 'The same account name appears in both patterns, so it does not tell them apart.', server: 'Both patterns were recorded on the same server, so that does not tell them apart.', top: 'Position in the list only reflects time. It says nothing about whether activity is normal.' }, fallback: 'Compare the facts listed for the two patterns.' },
];

export const CHECKS = {
  '2-terms': (ctx) => quizResult(reviewQuiz(TERMS, ctx.data?.answers), 'All four matched.', 'Not all matched yet. Read the note under each one.'),

  '2-ack': (ctx) => {
    if (ctx.c.status !== 'monitoring') return ok('The alert is acknowledged and the ticket is open.');
    return no(ctx.c.alert ? 'The alert is still waiting in the queue. Click "Acknowledge and open ticket" in the panel on the right.' : 'No alert has fired yet. It appears in the queue a few seconds after the session starts.');
  },

  '3-open': (ctx) => {
    const open = (ctx.data?.open || []).filter((id) => ctx.stream.get(id));
    if (!open.length) return no('No event is open yet. In the Alert tab, click the time at the left of a row under "Events that matched the rule".');
    const matched = new Set(ctx.c.alert?.matched || []);
    if (!open.some((id) => matched.has(id))) return no('An event is open, but it is not one of the events that matched the rule. Open one from the list in the Alert tab.');
    return ok('An event from the alert is open. Its raw line and fields are showing.');
  },

  '4-fields': (ctx) => quizResult(reviewQuiz(FIELDS_Q, ctx.data?.answers), 'All four fields identified. You can now say who, from where and what, using only the log line.', 'Some fields are not right yet. Read the note under each one.'),

  '5-task': (ctx) => {
    const s = ctx.data?.search;
    if (!s || !String(s.q || '').trim()) return no('The search box is empty. Type the query and press Search first.');
    const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    const res = ctx.stream.query({ q: String(s.q).slice(0, 400), source: s.source ? String(s.source) : undefined, from: num(s.from), to: num(s.to), limit: 100000 });
    const want = ctx.stream.events.filter((e) => (e._tags || []).some((x) => x === 'atk_fail' || x === 'atk_fail_after'));
    const got = new Set(res.events.map((e) => e.id));
    const hit = want.filter((e) => got.has(e.id)).length;
    const extra = res.total - hit;
    if (!res.total) return no('Your search returns no events. Check the spelling of the field names, that there is no space after a colon, and that no time range is set.');
    if (hit < want.length) {
      const why = s.from !== undefined && s.from !== null ? 'A time range is set: click "Clear time range".' : s.source && s.source !== 'winsec' ? 'A source button other than Windows is selected: click "All sources".' : 'One of your terms cuts them out: remove terms until they appear, then narrow again.';
      return no(`Too narrow. Your search finds ${hit} of the ${want.length} failed logons from that address, so evidence is hidden. ${why}`);
    }
    if (extra > Math.max(1, Math.floor(want.length * 0.1))) {
      return no(`Too broad. Your search returns ${res.total} events, and ${extra} of them are not failed logons from that address. Add the missing term: both event_id:4625 and src_ip: with the address are needed.`);
    }
    return ok(`Exactly right: ${want.length} events, every one a failed logon from that address. Broad enough to miss nothing, narrow enough to read.`);
  },

  '6-compare': (ctx) => quizResult(reviewQuiz(COMPARE_Q, ctx.data?.answers), 'Correct. You judged the pattern, not the single event.', 'Not quite. Read the note under each question.'),

  '7-open': (ctx) => {
    const open = (ctx.data?.open || []).map((id) => ctx.stream.get(id)).filter(Boolean);
    if (!open.length) return no('No event is open. Click the time at the left of the row that starts with event_id=4624.');
    if (open.some((e) => (e._tags || []).includes('atk_ok'))) return ok('The successful logon is open.');
    if (open.some((e) => String(e.fields.event_id) === '4625')) return no('That is one of the failed logons (4625). Open the row that starts with event_id=4624: it is the newest one, at the top of the list.');
    return no('That is not the successful logon from the alert. In the Alert tab, open the row that starts with event_id=4624.');
  },

  '7-facts': (ctx) => {
    const F = ctx.scn.facts;
    const spec = [
      { id: 'who', test: (a) => cleanUser(a) === F.USER, right: 'Read from target_user.', wrong: () => 'Read the target_user field. Type the account name as it appears there.' },
      { id: 'from', test: (a) => sameIp(a, F.ATK), right: 'Read from src_ip.', wrong: (a) => (sameIp(a, F.WEB_IP) ? 'That is the address of the server that was signed in to. The source is in src_ip.' : 'Read the src_ip field and type the address exactly.') },
      { id: 'to', answer: 'WEB01', right: 'The Host column names the server that recorded the logon.', why: { 'WS-SAL-007': 'That is the user\'s workstation. This logon was recorded by a different system: read the Host column.', DC01: 'A domain controller is not named in this event. Read the Host column.', FW01: 'FW01 is the firewall, which records network connections. This is a logon event: read the Host column.' }, fallback: '' },
      { id: 'result', answer: 'ok', right: 'Event 4624 is a successful logon.', why: { failed: 'A failed logon is event 4625. This event is 4624: read its description.', locked: 'Nothing in the event mentions a lockout. Read the description after event=.' }, fallback: '' },
      { id: 'noise', answer: 'logon_id', right: 'logon_id is a session number the server makes up. It identifies this session but says nothing about whether it is legitimate.', why: { src_ip: 'The source address is the most useful field here: it says where the sign-in came from.', auth_package: 'The sign-in method is worth noting, because it can differ from how this account normally signs in.', workstation: 'The name the source gives can be compared with the user\'s real workstation, so it does help.' }, fallback: '' },
    ];
    return quizResult(reviewQuiz(spec, ctx.data?.answers), 'All facts accepted: who, from where, to what, and what happened.', 'Some facts are not right yet. Read the note under each one.');
  },

  '8-intel': (ctx) => (ran(ctx.c, 'reputation', (i) => i === ctx.scn.facts.ATK)
    ? ok('The lookup is recorded in the case history. Read what it says about the address before you decide.')
    : no(ran(ctx.c, 'reputation') ? 'A lookup was run, but not for the source address in the alert. Enter that address exactly.' : 'No threat intelligence lookup has been run yet. In the Tools tab choose Threat intelligence, enter the source address and press Look up.')),

  '8-directory': (ctx) => {
    const items = [
      { id: 'dir', label: 'Directory lookup for the targeted account', ok: ran(ctx.c, 'user', (i) => cleanUser(i) === ctx.scn.facts.USER) },
      { id: 'chg', label: 'Change calendar listed', ok: ran(ctx.c, 'change') },
    ].map((i) => ({ ...i, message: i.ok ? 'Done.' : 'Not done yet.' }));
    return quizResult(items, 'Both checks are recorded in the case history.', 'One check is still missing.');
  },

  '8-classify': (ctx) => {
    if (past(ctx, 'l1_triage')) return ok('Triage has already been submitted.');
    const items = reviewFields(ctx, 'l1_triage', ['source', 'account', 'verdict', 'severity']);
    return quizResult(items, 'All four accepted. They are still only in the form: you submit them in step 10.', 'Not all accepted yet. Read the note for each one, change the answer and check again.');
  },

  '9-pin': (ctx) => {
    const fail = pinHas(ctx, ['atk_fail']);
    const success = pinHas(ctx, ['atk_ok', 'atk_session']);
    if (fail && success) return ok('Both kinds of evidence are pinned: the attempts and the success.');
    if (past(ctx, 'l1_triage')) return ok('Triage has already been submitted.');
    const items = [
      { id: 'f', label: 'A failed logon (4625) from the source address', ok: fail, message: fail ? 'Pinned.' : 'Not pinned yet.' },
      { id: 's', label: 'The successful logon (4624) from the source address', ok: success, message: success ? 'Pinned.' : 'Not pinned yet.' },
    ];
    return no(ctx.c.pins.length ? 'Something is pinned, but the required evidence is not complete.' : 'Nothing is pinned yet. Click Pin at the right of a row in the Alert tab.', items);
  },

  '9-select': (ctx) => {
    if (past(ctx, 'l1_triage')) return ok('Triage has already been submitted.');
    const [item] = reviewFields(ctx, 'l1_triage', ['evidence']);
    return item.ok ? ok('The cited evidence covers both the attempts and the success.') : no(item.message);
  },

  '10-decide': (ctx) => {
    if (past(ctx, 'l1_triage')) return ok('Triage submitted. The ticket has moved on with its evidence and notes.');
    const st = ctx.c.stages.l1_triage;
    if (st?.attempts) return no('The form was returned with notes. Read the note under each field that was not accepted, change it, and submit again.');
    return no('Triage has not been submitted yet. Choose a disposition, write the note, and press "Submit triage decision".');
  },

  '10-handoff': (ctx) => {
    if (past(ctx, 'l2_escalation')) return ok('Handed off. The same ticket is now with Tier 2.');
    if (!past(ctx, 'l1_triage')) return no('Submit the triage decision first.');
    return no(ctx.c.stages.l2_escalation?.attempts ? 'The handoff was returned with notes. Read the note under each field, change it, and submit again.' : 'The handoff has not been submitted yet. Complete the form and press "Hand off to Tier 2".');
  },

  '11-sweep': (ctx) => (ran(ctx.c, 'sweep', (i) => i === ctx.scn.facts.ATK)
    ? ok('The sweep shows the address in two sources: Windows logon events and firewall connections.')
    : no(ran(ctx.c, 'sweep') ? 'A sweep was run, but not for the source address. Enter that address exactly.' : 'No sweep has been run yet. In the Tools tab choose Fleet IOC sweep, enter the source address and press Run sweep.')),

  '11-correlate': (ctx) => {
    if (past(ctx, 'l2_investigation')) return ok('The investigation has already been submitted.');
    const after = pinHas(ctx, ['atk_data', 'atk_session']);
    const base = pinHas(ctx, ['legit', 'legit_typo', 'legit_after']);
    const items = [
      { id: 'a', label: 'An event showing what the address did after the success', ok: after, message: after ? 'Pinned.' : (pinHas(ctx, ['atk_net']) ? 'The firewall line you pinned shows a small connection, which does not show what the address did once it was in. Pin one of the large transfers (bytes over 1,000,000) recorded after the success.' : 'Not pinned yet.') },
      { id: 'b', label: 'A normal sign-in by the same account from her own workstation', ok: base, message: base ? 'Pinned.' : (otherServerPin(ctx) ? `The sign-in you pinned is to ${otherServerPin(ctx).host}, a different server. The comparison is with how she normally signs in to the portal: add host:WEB01 to the search.` : 'Not pinned yet.') },
    ];
    return quizResult(items, 'Both pinned. You now have the before, the attempts, the success and the after.', 'One piece of evidence is still missing.');
  },

  '11-findings': (ctx) => {
    if (past(ctx, 'l2_investigation')) return ok('All findings accepted and corroborated.');
    return no(ctx.c.stages.l2_investigation?.attempts ? 'The findings were returned. Accepted ones are locked; read the note under the others, correct them or their linked evidence, and submit again.' : 'The findings have not been submitted yet.');
  },

  '12-summary': (ctx) => {
    if (past(ctx, 'l2_validation')) return ok('The validation has already been signed off.');
    const text = String(ctx.data?.form?.values?.summary ?? ctx.c.stages.l2_validation?.draft?.values?.summary ?? '').toLowerCase();
    const F = ctx.scn.facts;
    const parts = [
      ['What happened', [/fail/, /guess/, /attempt/, /4625/, /brute/]],
      ['Why it is malicious or benign', [/malicious/, /attack/, /unauthori/, /not (a )?(company|corporate|known)/, /threat intel/, /reported/, /compromis/, /benign/]],
      ['The evidence', [new RegExp(F.ATK.replace(/\./g, '\\.')), /pinned/, /log/, /event/, /firewall/, /4624/]],
      ['The likely cause', [/password/, /credential/, /lockout/, /second factor|mfa/]],
      ['The impact', [/data/, /transfer/, /download/, /\bmb\b/, /portal/, /access/]],
      ['What is still not known', [/unknown/, /not (yet )?(known|confirmed|clear)/, /unclear/, /unconfirmed/, /still/, /review/, /no evidence/, /cannot/]],
    ];
    const items = parts.map(([label, res], i) => {
      const found = res.some((r) => r.test(text));
      return { id: `p${i}`, label, ok: found, message: found ? 'Covered.' : 'Not found in your text.' };
    });
    if (text.trim().length < 100) return no(`The summary is ${text.trim().length} characters. Write at least 100.`, items);
    return quizResult(items, 'All six parts are present. A reviewer would still read it for accuracy.', 'The summary is missing some parts. Add a sentence for each one that is not covered.');
  },

  '12-signoff': (ctx) => {
    if (past(ctx, 'l2_validation')) return ok('Validation signed off. The incident is declared and the ticket is with Tier 3.');
    return no(ctx.c.stages.l2_validation?.attempts ? 'The validation was returned with notes. Read the note under each field, change it, and submit again.' : 'The validation has not been submitted yet.');
  },

  '13-contain': (ctx) => {
    const F = ctx.scn.facts;
    const reset = ctx.st.reset.has(F.USER);
    const blocked = ctx.st.ipBlocked(F.ATK);
    const disabled = ctx.st.disabled.has(F.USER);
    const items = [
      { id: 'r', label: 'Credentials of the affected account reset', ok: reset, message: reset ? 'Done.' : (disabled ? 'The account was disabled instead. That stops the attacker but also locks out the real user. Reset the credentials as well.' : 'Not done yet.') },
      { id: 'b', label: 'Source address blocked at the firewall', ok: blocked, message: blocked ? 'Done.' : (ctx.st.blockedIps.size ? 'An address is blocked, but not the source address from the alert.' : 'Not done yet.') },
    ];
    const harm = ctx.c.actions.filter((a) => a.ok && ['isolate_host', 'reimage_host'].includes(a.type));
    const extra = harm.length ? ` Note: ${harm.map((a) => `${a.label.toLowerCase()} on ${a.target}`).join(', ')} went beyond the confirmed scope, and the report will show a deduction for it.` : '';
    return quizResult(items, `The password is useless to the attacker and the address can no longer reach the portal.${extra}`, `Containment is not complete.${extra}`);
  },

  '13-notify': (ctx) => (ctx.st.notified.has('ir_lead')
    ? ok(`The incident lead has been notified.${ctx.st.notified.has('user_mgr') ? ' So has the affected user.' : ' Telling the affected user as well is good practice.'}`)
    : no(ctx.st.notified.size ? 'A notification was sent, but not to the incident response lead, who owns the response.' : 'Nobody has been notified yet. Choose "Notify stakeholder" and select the CISO / incident response lead.')),

  '13-declare': (ctx) => {
    if (past(ctx, 'l3_response')) return ok('Response declared complete. The actions are locked.');
    const blocked = ctx.scn.guard?.('l3_response', ctx.c);
    return no(blocked || 'Press "Declare response complete", then confirm.');
  },

  '14-negative': (ctx) => {
    if (pinHas(ctx, ['atk_denied'])) return ok('Pinned: a firewall line recorded after the block shows the address being refused. That is the negative test.');
    if (past(ctx, 'l3_verify')) return ok('The response check has already been recorded.');
    if (pinHas(ctx, ['atk_fail_after'])) return no('You pinned a failed logon recorded after the reset. That shows the old password being rejected, which is useful, but the address still reached the server. Pin a firewall line with action=deny.');
    const seen = ctx.stream.events.some((e) => (e._tags || []).includes('atk_denied'));
    return no(seen ? 'A deny line exists in the logs but is not pinned. Search for the source address with action:deny and pin a result.' : 'No deny line has been logged yet. The address retries about every 35 seconds: wait, then search again.');
  },

  '14-positive': (ctx) => {
    if (pinHas(ctx, ['legit_after'])) return ok('Pinned: the real user signed in from her own workstation after the reset. That is the positive test.');
    if (past(ctx, 'l3_verify')) return ok('The response check has already been recorded.');
    // Disabling the account makes this test impossible. That is a real result,
    // so it is recorded as a failed test and the learner may continue.
    if (ctx.st.disabled.has(ctx.scn.facts.USER)) return { ok: true, warn: true, message: 'Positive test failed: the account was disabled during the response, so the real user cannot sign in at all. That is the cost of that action. It is recorded in your summary; continue to the form and record what you can.' };
    const other = otherServerPin(ctx);
    const resetAt = ctx.st.reset.get(ctx.scn.facts.USER);
    if (other && resetAt && other.ts > resetAt) return no(`The sign-in you pinned is to ${other.host}, a different server. The test is whether she can still use the portal: add host:WEB01 to the search and pin a result recorded after the reset.`);
    if (pinHas(ctx, ['legit'])) return no('The sign-in you pinned was recorded before the reset, so it does not show the account working afterwards. Pin one recorded after it.');
    const seen = ctx.stream.events.some((e) => (e._tags || []).includes('legit_after'));
    return no(seen ? 'A sign-in after the reset exists in the logs but is not pinned. Search event_id:4624 host:WEB01 target_user:*r.delgado and pin the newest one from her workstation.' : 'She has not signed in again since the reset. She does so about once a minute: wait, then search again.');
  },

  '14-record': (ctx) => {
    if (!past(ctx, 'l3_verify')) return no(ctx.c.stages.l3_verify?.attempts ? 'The check was returned with notes. Read the note under each field, change it, and submit again.' : 'The response check has not been recorded yet.');
    const sc = ctx.c.stages.l3_verify?.score;
    const full = sc && sc.max && sc.earned >= sc.max * 0.999;
    return ok(full ? 'Validation recorded with both proofs accepted.' : 'Validation recorded. Not every part was accepted first time; the report shows which.');
  },

  '15-close': (ctx) => (ctx.c.status === 'closed'
    ? ok('The ticket is closed and the report is ready.')
    : no(ctx.c.stages.closure?.attempts ? 'The closure form was returned with notes. Read the note under each field, change it, and submit again.' : 'The ticket is still open. Complete the closure form and press "Close ticket".')),

  '16-summary': (ctx) => (ctx.c.status === 'closed' ? ok('Summary ready.') : no('Close the ticket first.')),
};

export function buildCtx(c, scn, stream, data) {
  return { c, scn, stream, data: data || {}, st: deriveState(c.actions) };
}

// What the browser receives for one beat.
export function publicBeat(b, ctx) {
  const { check, ...rest } = b;
  return {
    ...rest,
    stepTitle: STEPS[b.step - 1],
    ...(check ? { check: { label: check.label, auto: !!check.auto, collect: check.collect || [] } } : {}),
    ...(ctx ? { widget: widgetFor(b, ctx) } : {}),
  };
}
