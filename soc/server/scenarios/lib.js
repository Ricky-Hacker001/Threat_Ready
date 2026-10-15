// Scenario helper. Builds a full scenario module (the shape s02-authfail.js
// uses) from a compact definition that follows the Scenario specifications
// tab: alert, story, events with tags, tool records, decoys, questions with
// answers, hints and explanations, response objectives and the truth.
//
// Standard stages (Scenario specifications, "Standard stages"):
//   Foundations   l1_triage (60), l2_review (15, only on a wrong escalation), closure (40)
//   Intermediate  benign: l1_triage (25), l2_review (15), closure (30)
//                 attack: l1_triage (25), l2_investigation (45), closure (30)
//   Expert        l1_triage (15), l2_investigation (30), l3_response (35), closure (20)
// A wrong close at L1 sends the ticket to closure and the skipped
// investigation and response stages count as zero (stage.missed).

import { rng } from '../engine/rng.js';
import { utc } from '../engine/common.js';

export const opt = (value, label) => ({ value, label });
const opts = (list) => list.map(([v, l]) => opt(v, l));

// --- checks: "<tool> run on <input>" -------------------------------------
const norm = (s) => String(s || '').toLowerCase().replace(/^meridian\\/, '').trim();
export function ran(tool, inputs) {
  const want = inputs === undefined ? null : [].concat(inputs).map(norm);
  return (c) => c.toolRuns.some((t) => t.tool === tool && (!want || want.some((w) => norm(t.input) === w || norm(t.input).includes(w))));
}
export const searched = (needle) => (c) => (c.searches || []).some((s) => s.q.toLowerCase().includes(String(needle).toLowerCase()));

// --- field builders ------------------------------------------------------
export function single(id, label, points, options, accept, extra = {}) {
  return { id, type: 'single', label, points, options: opts(options), key: { accept, hint: extra.hint, explain: extra.explain }, ...rest(extra) };
}
export function multi(id, label, points, options, set, extra = {}) {
  return { id, type: 'multi', label, points, options: opts(options), key: { set, hint: extra.hint, explain: extra.explain }, ...rest(extra) };
}
export function text(id, label, points, accept, extra = {}) {
  return { id, type: 'text', label, points, placeholder: extra.placeholder, key: { accept: [].concat(accept), norm: extra.norm || 'lower', hint: extra.hint, explain: extra.explain, support: extra.support }, ...rest(extra) };
}
export function host(id, label, points, accept, extra = {}) {
  return { id, type: 'host', label, points, key: { accept, hint: extra.hint, explain: extra.explain, support: extra.support }, ...rest(extra) };
}
export function account(id, label, points, accept, extra = {}) {
  return { id, type: 'account', label, points, key: { accept, hint: extra.hint, explain: extra.explain, support: extra.support }, ...rest(extra) };
}
export function hosts(id, label, points, set, extra = {}) {
  return { id, type: 'hosts', label, points, key: { set, hint: extra.hint, explain: extra.explain, support: extra.support }, ...rest(extra) };
}
export function accounts(id, label, points, set, extra = {}) {
  return { id, type: 'accounts', label, points, key: { set, hint: extra.hint, explain: extra.explain, support: extra.support }, ...rest(extra) };
}
export function order(id, label, points, items, correct, extra = {}) {
  return { id, type: 'order', label, points, items: items.map(([i, l]) => ({ id: i, label: l })), key: { order: correct, hint: extra.hint, explain: extra.explain }, ...rest(extra) };
}
export function pins(id, label, points, tags, extra = {}) {
  const groups = Object.fromEntries(tags.map((t) => [t, [t]]));
  return {
    id, type: 'pins', label, points, min: extra.min || 1,
    help: extra.help || 'Choose the pinned events your decision rests on.',
    key: { groups, minGroups: tags.length, minPrecision: 0.6, describe: extra.describe || `Events tagged in the story as: ${tags.join(', ')}.`, explain: extra.explain, hint: extra.hint },
    ...rest(extra),
  };
}
export function checks(id, label, points, list, extra = {}) {
  return { id, type: 'checks', label, points, help: 'Updated from the tools you have run on this case.', key: { checks: list, explain: extra.explain }, ...rest(extra) };
}
function rest(extra) {
  const out = {};
  if (extra.skills) out.skills = extra.skills;
  if (extra.help) out.help = extra.help;
  if (extra.summary) out.summary = extra.summary;
  if (extra.linkable || extra.support) out.linkable = true;
  if (extra.sets) out.sets = extra.sets;
  if (extra.required === false) out.required = false;
  return out;
}
// A linked finding: answer plus the pinned event that proves it.
export const link = (field, ...tags) => ({ ...field, linkable: true, key: { ...field.key, support: tags } });

export const VERDICTS = [
  ['tp', 'True positive: malicious or unauthorised activity'],
  ['btp', 'Benign true positive: real activity, but authorised or expected'],
  ['fp', 'False positive: the rule matched activity it should not have'],
  ['unknown', 'Inconclusive: not enough data to decide'],
];
const SEV = ['low', 'medium', 'high', 'critical'];

function severityAccept(spec) {
  if (typeof spec === 'object') return spec;
  const i = SEV.indexOf(spec);
  const acc = { [spec]: 1 };
  if (i > 0) acc[SEV[i - 1]] = 0.5;
  if (i < 3) acc[SEV[i + 1]] = 0.5;
  return acc;
}

// --- jitter context --------------------------------------------------------
function makeCtx({ t0, seed, variant, level }, def, events) {
  const r = rng(seed, 'scn', def.code);
  const jr = rng(seed, 'jitter', def.code);
  const jc = variant ? def.jitter?.counts ?? 0.25 : 0;
  const jt = variant ? def.jitter?.timing ?? 0.2 : 0;
  const tf = 1 + (jr.f() * 2 - 1) * jt;
  const ctx = {
    t0, r, level, variant,
    // Offset in seconds from t0, stretched by the attempt's timing factor.
    T: (off) => t0 + Math.round(off * (off < 0 ? Math.min(tf, ((def.history || 1800) - 30) / Math.max(1, -off)) : tf) * 1000),
    // A count that varies per attempt but never drops below the story minimum.
    n: (base, min = 1) => Math.max(min, Math.round(base * (1 + (jr.f() * 2 - 1) * jc))),
    add: (tags, ev) => { ev._tags = [].concat(tags); events.push(ev); return ev; },
    pick: (list) => list[Math.floor(r.f() * list.length)],
  };
  return ctx;
}

// --- module builder -------------------------------------------------------
export function defineScenario(def) {
  const level = def.level;
  const attack = !def.benign;
  const weights = level === 'foundations' ? { l1: 60, review: 15, closure: 40 }
    : level === 'intermediate' ? { l1: 25, review: 15, l2: 45, closure: 30 }
      : { l1: 15, review: 15, l2: 30, l3: 35, closure: 20 };
  const route = def.triage.route?.accept || (level === 'foundations' || def.benign ? 'close_l1' : 'escalate_l2');
  const needsL2 = level !== 'foundations' && !def.benign;
  const needsL3 = level === 'expert' && !!def.response;

  // ---------- L1 triage ----------
  const t = def.triage;
  const l1Fields = [];
  if (t.checks?.length) l1Fields.push(checks('checks', 'Context checked', 6, t.checks, { explain: t.checksExplain || 'Context first: confirm what the entities are before judging.', skills: t.checksSkills || ['inv.pivot'] }));
  l1Fields.push(...(t.fields || []));
  l1Fields.push(single('verdict', t.verdict.label || 'Verdict', 10, def.verdicts || VERDICTS, t.verdict.accept, { explain: t.verdict.explain, hint: t.verdict.hint, skills: ['tri.verdict', ...(def.benign ? ['tri.false-positive'] : [])], summary: 'Verdict' }));
  l1Fields.push(single('severity', 'Severity', 4, SEV.map((s) => [s, s[0].toUpperCase() + s.slice(1)]), severityAccept(t.severity.accept), { explain: t.severity.explain, skills: ['tri.severity'], sets: 'severity', summary: 'Severity' }));
  l1Fields.push(single('route', 'Routing decision', 6, [['close_l1', 'Close at L1'], ['escalate_l2', 'Escalate to L2']], route, { explain: t.route?.explain || (route === 'close_l1' ? 'Tier 1 has everything needed to close this ticket.' : 'This needs Tier 2 investigation; Tier 1 cannot close it.'), skills: ['tri.escalation'], summary: 'Routing' }));
  l1Fields.push(pins('evidence', 'Key evidence', 6, t.evidence.tags, { explain: t.evidence.explain, describe: t.evidence.describe, skills: ['doc.evidence'], min: t.evidence.min || 1 }));
  l1Fields.push({ id: 'note', type: 'longtext', label: 'Triage note', min: 40, points: 0, help: 'What you checked and why you reached this decision.', key: { explain: 'Recorded in the case file.' } });

  const stages = [{ id: 'monitoring', label: 'Monitor', tier: 'L1', kind: 'monitor' }];
  stages.push({
    id: 'l1_triage', label: 'L1 triage', tier: 'L1', kind: 'form', weight: weights.l1, submitLabel: 'Submit triage decision',
    intro: t.intro || 'Classify the alert. Check the context, pin the events your decision rests on, then record a verdict, a severity and where the ticket goes.',
    fields: l1Fields,
  });

  // ---------- L2 review (reached only by a wrong escalation) ----------
  if (route === 'close_l1') {
    stages.push({
      id: 'l2_review', label: 'L2 review', tier: 'L2', kind: 'form', weight: weights.review, submitLabel: 'Return ticket',
      intro: 'Tier 1 escalated this ticket. Review it and decide where it goes.',
      fields: [
        single('assessment', 'Tier 2 assessment', 5, def.review?.options || [
          ['incident', 'Confirmed incident: keep it at Tier 2'],
          ['closeable', 'Tier 1 had what it needed to close this'],
          ['unclear', 'Cannot determine; more data is needed'],
        ], def.review?.accept || 'closeable', { explain: def.review?.explain || 'The context Tier 1 can reach already explains this alert.', skills: ['tri.escalation'] }),
        single('return', 'Routing', 5, [['return', 'Return to Tier 1 for closure, with feedback on what to check before escalating'], ['l3', 'Hand to incident response (L3)'], ['hold', 'Hold at Tier 2']], 'return', { explain: 'Nothing here needs Tier 2 or Tier 3. The useful output is feedback so the next one is closed at Tier 1.', skills: ['tri.escalation'] }),
      ],
    });
  }

  // ---------- L2 investigation ----------
  if (needsL2) {
    stages.push({
      id: 'l2_investigation', label: 'Investigation', tier: 'L2', kind: 'form', weight: weights.l2, submitLabel: 'Submit findings',
      intro: def.l2.intro || 'Investigate the escalated ticket. Each finding needs an answer and, where asked, the pinned event that proves it.',
      fields: def.l2.fields,
    });
  }

  // ---------- L3 response ----------
  if (needsL3) {
    stages.push({ id: 'l3_response', label: 'L3 response', tier: 'L3', kind: 'response', weight: weights.l3, intro: def.response.intro || 'Contain, eradicate and recover. Act on what the evidence supports; disruptive actions outside the incident scope cost points.' });
  }

  // ---------- Closure ----------
  const cl = def.closure;
  const closureFields = [...(cl.fields || [])];
  closureFields.push(single('disposition', 'Final disposition', 8, cl.disposition.options, cl.disposition.accept, { explain: cl.disposition.explain, skills: ['tri.verdict'], summary: 'Disposition' }));
  closureFields.push(single('root_cause', 'Root cause', 8, cl.rootCause.options, cl.rootCause.accept, { explain: cl.rootCause.explain, skills: ['doc.root-cause'] }));
  closureFields.push(multi('actions', 'Follow-up actions', 10, cl.actions.options, cl.actions.set, { explain: cl.actions.explain, help: 'Select every action you would take or recommend.', skills: cl.actions.skills || ['res.proportionality'] }));
  closureFields.push({ id: 'summary', type: 'longtext', label: 'Closure summary', min: 80, points: 0, help: 'Two or three sentences a reviewer could read without the case file.', key: { explain: 'Recorded in the case file.' } });
  stages.push({
    id: 'closure', label: 'Closure', tier: needsL3 ? 'L3' : needsL2 ? 'L2' : 'L1', kind: 'form', weight: weights.closure, final: true, submitLabel: 'Close ticket',
    intro: cl.intro || 'Record the final disposition, the root cause and what should happen next. Closing the ticket releases the after-action review.',
    fields: closureFields,
  });

  const order = stages.map((s) => s.id);
  const after = (id) => order.slice(order.indexOf(id) + 1);

  function build(input) {
    const events = [];
    const ctx = makeCtx(input, def, events);
    const out = def.build(ctx) || {};
    if (def.decoys) def.decoys(ctx);
    return { events, periodic: out.periodic || [] };
  }

  function alert(stream, c) {
    const until = c.t0 + (def.alertAt ?? 5) * 1000;
    const tagged = (tags) => stream.events.filter((e) => (e._tags || []).some((x) => [].concat(tags).includes(x)) && e.ts <= until);
    const a = def.alert({ stream, c, tagged, count: (tag) => tagged(tag).length, utc, until });
    const matched = tagged(def.alertTags);
    return {
      id: 'A1', rule: def.rule, severity: def.severity, title: def.title,
      description: a.description, entity: a.entity || { host: null, ip: null, user: null }, details: a.details || [], guidance: a.guidance || [],
      matched: matched.slice(-18).map((e) => e.id), matchedTotal: matched.length,
    };
  }

  function flow(stageId, { values }) {
    if (stageId === 'l1_triage') {
      const esc = values.route === 'escalate_l2';
      if (route === 'close_l1') {
        if (esc) return { next: 'l2_review', result: 'Escalated', notes: [{ actor: 'Tier 2 queue', text: 'Escalation accepted for review.' }] };
        return { next: 'closure' };
      }
      if (!esc) {
        const missed = after('l1_triage').filter((s) => s !== 'closure');
        return { next: 'closure', result: 'Closed at L1', missed, notes: [{ actor: 'SOC shift lead', text: 'QA review: this ticket needed Tier 2 investigation. The investigation and response stages it skipped are scored as not done.' }] };
      }
      return null;
    }
    if (stageId === 'l2_review') return { next: 'closure', notes: [{ actor: 'L2 analyst', text: def.review?.feedback || 'Returned to Tier 1 for closure. Check the context tools before escalating an alert like this.' }] };
    return null;
  }

  const response = def.response ? {
    scope: def.response.scope || {}, objectives: def.response.objectives || [], artifacts: def.response.artifacts || {},
    notify: def.response.notify || {}, textTargets: def.response.textTargets, impacts: def.response.impacts, collateralReasons: def.response.collateralReasons,
    contained: def.response.contained || (() => false), purgeTags: def.response.purgeTags,
  } : { scope: {}, objectives: [], notify: {}, artifacts: {} };

  return {
    id: def.code, code: def.code, level, version: def.version || 1, keyVersion: def.keyVersion || 1,
    historySeconds: def.history || 30 * 60,
    catalog: {
      title: def.title, queue: def.queue || 'security alerts',
      blurb: def.blurb || 'Work the ticket from the alert queue to closure.',
      difficulty: { foundations: 'Foundations', intermediate: 'Intermediate', expert: 'Expert' }[level],
      minutes: def.minutes || { foundations: '10-15', intermediate: '20-35', expert: '45-90' }[level],
      tiers: { foundations: 'L1', intermediate: def.benign ? 'L1 (L2 if escalated)' : 'L1, L2', expert: 'L1, L2, L3' }[level],
      sources: def.sources,
      sourceGroups: def.sourceGroups,
      environment: def.environment || 'Meridian Freight Systems, a simulated company. All logs are synthetic. All times are UTC.',
    },
    skills: def.skills,
    meta: { verdictField: 'verdict', severityField: 'severity', routeField: 'route', benign: !!def.benign },
    entities: def.entities || {},
    jitter: def.jitter || { counts: 0.25, timing: 0.2 },
    build,
    alert: { at: def.alertAt ?? 5, build: alert },
    relatedAlerts: [],
    stages,
    flow,
    intel: () => def.intel || {},
    sandbox: def.sandbox || {},
    assetNotes: def.assetNotes || {},
    accountNotes: def.accountNotes || {},
    accountState: def.accountState || {},
    assetRecords: def.assetRecords || {},
    changes: def.changes || [],
    secret: {
      response,
      truth({ t0 }) {
        const T = (off) => t0 + off * 1000;
        const tr = def.truth;
        return { summary: tr.summary, timeline: (tr.timeline || []).map(([at, txt]) => ({ ts: T(at), text: txt })), iocs: tr.iocs || [] };
      },
    },
    _test: def.test || {},
  };
}
