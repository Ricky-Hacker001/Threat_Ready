// Server-authoritative LabEngine for TR-RED-001 (AeroCart web pentest). The browser never decides
// state, findings, objectives or scores. Predicates, hints-not-yet-requested, remediation answer
// keys and canary flag values stay here; only public projections (view/status/report) reach clients.

import { HttpRequest, HttpResponse, parseCookieHeader } from './http';
import * as fx from './fixture';
import { handle, TARGET_HOST, TargetEvent } from './target';
import { runTerminal, initTermFs, TermState, SUPPORTED_COMMANDS } from './terminal';
import { FINDINGS, FINDING, OBJECTIVES, OBJECTIVE, CHAPTERS, BRIEFING, scoreReport, Severity, GUIDE_STEPS, GUIDE_MODES, LEVEL_TIPS, GuideMode, PREFILL, STEP_WHY, LEVEL_WHY } from './scenario';

export class LabError extends Error { constructor(public code: string, message: string) { super(message); } }
export interface LabAction { type: string; params?: any }
export interface ActionResult { ok: boolean; code?: string; message: string; result?: any }
export interface LabEngine {
  labId: string; title: string;
  definition(): any;
  createInitialState(mode?: string): any;
  dispatch(state: any, action: LabAction): { state: any; result: ActionResult };
  view(state: any): any;
  status(state: any): any;
  report(state: any, meta: any): any;
}

const SEVERITIES: Severity[] = ['Critical', 'High', 'Medium', 'Low'];
const clone = <T>(x: T): T => structuredClone(x);
const bad = (msg: string): never => { throw new LabError('VALIDATION_FAILED', msg); };
const str = (v: any, name: string, max = 2000): string => { if (typeof v !== 'string' || v.length > max) bad(`Invalid value for "${name}".`); return v; };
const oneOf = <T>(v: any, opts: readonly T[], name: string): T => { if (!opts.includes(v)) bad(`"${name}" must be one of: ${opts.join(', ')}.`); return v; };

export const simTime = (s: any) => new Date(new Date(s.clock.start).getTime() + s.clock.minutes * 60000).toISOString();
const timeline = (s: any, kind: 'story' | 'good' | 'warn' | 'bad' | 'info', text: string) => { s.sim.timeline.push({ at: simTime(s), kind, text }); if (s.sim.timeline.length > 200) s.sim.timeline.shift(); };

// ---------- shared request processor (browser, proxy/repeater, terminal curl all funnel here) ----------
function processRequest(s: any, req: HttpRequest, tool: string, useJar = false): { res: HttpResponse; historyId: string } {
  const t = s.target as fx.TargetState;
  const merged: HttpRequest = {
    method: (req.method || 'GET').toUpperCase(),
    path: req.path || '/',
    query: req.query || '',
    headers: { ...(req.headers || {}) },
    cookies: useJar ? { ...s.browser.cookies, ...(req.cookies || {}) } : { ...(req.cookies || {}) },
    body: req.body || '',
  };
  // If a raw Cookie header was supplied (repeater), fold it into cookies.
  if (merged.headers['cookie']) Object.assign(merged.cookies, parseCookieHeader(merged.headers['cookie']));

  const { res, events, setCookies } = handle(t, merged);
  if (useJar) for (const [k, v] of Object.entries(setCookies)) s.browser.cookies[k] = v;

  const id = `h-${String(++s.seqReq).padStart(4, '0')}`;
  s.history.push({ id, at: simTime(s), tool, request: merged, response: res, events: events.map(e => e.type), setCookies });
  if (s.history.length > 500) s.history.shift();

  applySignals(s, merged, events);
  return { res, historyId: id };
}

function applySignals(s: any, req: HttpRequest, events: TargetEvent[]) {
  // recon tracking
  const key = `${req.method} ${req.path}`;
  if (!s.sim.recon.routeSet[key]) { s.sim.recon.routeSet[key] = true; s.sim.recon.routes = Object.keys(s.sim.recon.routeSet).length; }
  if (req.path === '/robots.txt') s.sim.recon.robots = true;
  if (req.path.startsWith('/api')) s.sim.recon.apiSeen = true;
  if (req.path.startsWith('/admin')) s.sim.recon.adminSeen = true;
  if (req.path === '/download') s.sim.recon.filesSeen = true;
  // detection → confirmation
  for (const ev of events) {
    s.sim.signals[ev.type] = (s.sim.signals[ev.type] || 0) + 1;
    const f = FINDINGS.find(x => x.confirmEvent === ev.type);
    if (f) {
      const fsr = s.sim.findings[f.id];
      fsr.lastEventAt = simTime(s);
      if (!fsr.confirmed) { fsr.confirmed = true; fsr.confirmedAt = simTime(s); fsr.proof = clone(req); timeline(s, 'good', `Confirmed: ${f.id} ${f.title}.`); }
      else if (!fsr.proof) fsr.proof = clone(req);
    }
  }
}

// ---------- action handlers ----------
type Ctx = { s: any; p: any };
type Handler = { kind: 'nav' | 'test' | 'change' | 'meta'; run: (c: Ctx) => { message: string; result?: any } };

const parseUrlArg = (url: string) => { let u = url || '/'; if (/^https?:\/\//i.test(u)) u = u.replace(/^https?:\/\/[^/]+/i, '') || '/'; if (!u.startsWith('/')) u = '/' + u; const qi = u.indexOf('?'); return { path: qi === -1 ? u : u.slice(0, qi), query: qi === -1 ? '' : u.slice(qi + 1) }; };

const H: Record<string, Handler> = {
  'engagement.acknowledge': { kind: 'meta', run: ({ s }) => {
    if (s.sim.acknowledged) return { message: 'Engagement already acknowledged.' };
    s.sim.acknowledged = true; timeline(s, 'story', 'Engagement ENG-2041 acknowledged. You are the tester on record.');
    return { message: 'Engagement acknowledged.' };
  } },

  'browser.navigate': { kind: 'nav', run: ({ s, p }) => {
    const method = oneOf((p.method || 'GET').toUpperCase(), ['GET', 'POST'] as const, 'method');
    const { path, query } = parseUrlArg(str(p.url, 'url', 2000));
    if (s.proxy.intercepting) {
      const held: HttpRequest = { method, path, query, headers: { 'user-agent': 'AeroCart-Browser/1.0', ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, cookies: { ...s.browser.cookies }, body: p.body ? str(p.body, 'body', 8000) : '' };
      s.proxy.held = { request: held, from: 'browser' };
      return { message: 'Request intercepted — held in the proxy. Forward or drop it.', result: { intercepted: true, held } };
    }
    const req: HttpRequest = { method, path, query, headers: { 'user-agent': 'AeroCart-Browser/1.0', ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, cookies: {}, body: p.body ? str(p.body, 'body', 8000) : '' };
    const { res, historyId } = processRequest(s, req, 'browser', true);
    s.browser.url = path + (query ? `?${query}` : '');
    s.browser.history.push(s.browser.url); if (s.browser.history.length > 100) s.browser.history.shift();
    return { message: `${res.status} ${res.statusText}`, result: { historyId, response: pubRes(res) } };
  } },

  'browser.setCookie': { kind: 'meta', run: ({ s, p }) => { const name = str(p.name, 'name', 60); const value = str(p.value, 'value', 4000); s.browser.cookies[name] = value; return { message: `Browser cookie ${name} set.` }; } },
  'browser.clearCookies': { kind: 'meta', run: ({ s }) => { s.browser.cookies = {}; return { message: 'Browser cookie jar cleared.' }; } },

  'proxy.setIntercept': { kind: 'meta', run: ({ s, p }) => { s.proxy.intercepting = !!p.on; if (!p.on) s.proxy.held = null; return { message: `Interception ${p.on ? 'on' : 'off'}.` }; } },
  'proxy.resolveHeld': { kind: 'nav', run: ({ s, p }) => {
    if (!s.proxy.held) throw new LabError('LAB_ACTION_UNSUPPORTED', 'No intercepted request is held.');
    const action = oneOf(p.action, ['forward', 'drop'] as const, 'action');
    if (action === 'drop') { s.proxy.held = null; return { message: 'Held request dropped.' }; }
    const edited = p.request ? reqFromParams(p.request) : s.proxy.held.request;
    s.proxy.held = null;
    const { res, historyId } = processRequest(s, edited, 'browser', true);
    s.browser.url = edited.path + (edited.query ? `?${edited.query}` : '');
    return { message: `Forwarded — ${res.status} ${res.statusText}`, result: { historyId, response: pubRes(res) } };
  } },

  'proxy.send': { kind: 'test', run: ({ s, p }) => {
    const req = reqFromParams(p.request);
    const { res, historyId } = processRequest(s, req, 'repeater', false);
    return { message: `${res.status} ${res.statusText} · ${res.body.length} bytes · ${res.timeMs} ms`, result: { historyId, response: pubRes(res) } };
  } },

  'terminal.exec': { kind: 'test', run: ({ s, p }) => {
    const line = str(p.line, 'line', 1000);
    const ts: TermState = s.terminal;
    const r = runTerminal(ts, line, {
      runRequest: (req, tool) => processRequest(s, req, tool).res,
      jwtSecret: () => s.target.jwtSecret,
    });
    return { message: `terminal: ${r.requests} request(s)`, result: { output: r.out, cwd: ts.cwd, requests: r.requests } };
  } },

  'inspect': { kind: 'meta', run: ({ s, p }) => { const key = str(p.key, 'key', 200); if (!s.sim.inspected[key] && Object.keys(s.sim.inspected).length < 500) s.sim.inspected[key] = simTime(s); if (/source|view-source|headers/i.test(key)) s.sim.recon.sourceSeen = true; return { message: 'noted' }; } },

  'finding.report': { kind: 'meta', run: ({ s, p }) => {
    const f = FINDING[str(p.findingId, 'findingId', 40)]; if (!f) throw new LabError('VALIDATION_FAILED', 'Unknown finding.');
    const fsr = s.sim.findings[f.id];
    if (!fsr.confirmed) { s.sim.wrongReports++; throw new LabError('LAB_ACTION_UNSUPPORTED', 'Demonstrate (confirm) this vulnerability with the tools before documenting it.'); }
    const severity = oneOf(p.severity, SEVERITIES, 'severity');
    fsr.reported = true; fsr.reportedSeverity = severity; fsr.reportedAt = simTime(s);
    fsr.affectedRoute = p.affectedRoute ? str(p.affectedRoute, 'affectedRoute', 120) : f.routes[0];
    fsr.note = p.note ? str(p.note, 'note', 2000) : '';
    timeline(s, 'info', `Documented finding ${f.id} as ${severity}.`);
    return { message: `Finding ${f.id} documented (${severity}).` };
  } },

  'finding.remediate': { kind: 'change', run: ({ s, p }) => {
    const f = FINDING[str(p.findingId, 'findingId', 40)]; if (!f) throw new LabError('VALIDATION_FAILED', 'Unknown finding.');
    const opt = f.options.find(o => o.id === p.optionId); if (!opt) throw new LabError('VALIDATION_FAILED', 'Unknown remediation option.');
    const fsr = s.sim.findings[f.id];
    if (!opt.correct) { s.sim.wrongFixes++; timeline(s, 'warn', `Remediation attempt on ${f.id} did not address the root cause.`); throw new LabError('LAB_ACTION_UNSUPPORTED', 'That change does not fix the root cause. Re-read the evidence and choose again.'); }
    if (s.target.fixes[f.klass]) return { message: `${f.id} is already remediated. Re-test to verify.` };
    s.target.fixes[f.klass] = true; fsr.remediated = true; fsr.remediatedAt = simTime(s);
    // A regression check: if a previously verified finding's fix was toggled off elsewhere it would reopen; not applicable here (fixes only turn on).
    timeline(s, 'good', `Remediation applied for ${f.id}. Verify it with a re-test.`);
    return { message: `Remediation applied for ${f.id}. Run finding.retest to verify.` };
  } },

  'finding.retest': { kind: 'test', run: ({ s, p }) => {
    const f = FINDING[str(p.findingId, 'findingId', 40)]; if (!f) throw new LabError('VALIDATION_FAILED', 'Unknown finding.');
    const fsr = s.sim.findings[f.id];
    if (!fsr.confirmed || !fsr.proof) throw new LabError('LAB_ACTION_UNSUPPORTED', 'Confirm this finding first — there is no proof request to re-test.');
    if (!s.target.fixes[f.klass]) throw new LabError('LAB_ACTION_UNSUPPORTED', 'Apply the remediation before re-testing.');
    const { res, historyId } = processRequest(s, fsr.proof, 'retest', false);
    const stillVuln = s.history[s.history.length - 1].events.includes(f.confirmEvent);
    if (stillVuln) { fsr.verified = false; timeline(s, 'warn', `Re-test of ${f.id} still reproduces the issue.`); return { message: `Re-test FAILED — ${f.id} is still exploitable.`, result: { passed: false, historyId, response: pubRes(res) } }; }
    if (!fsr.verified) { fsr.verified = true; fsr.verifiedAt = simTime(s); timeline(s, 'good', `Verified: ${f.id} ${f.title} is fixed.`); }
    return { message: `Re-test PASSED — ${f.id} is fixed and verified.`, result: { passed: true, historyId, response: pubRes(res) } };
  } },

  'evidence.add': { kind: 'meta', run: ({ s, p }) => {
    const id = str(p.historyId, 'historyId', 20);
    if (!s.history.some((h: any) => h.id === id)) throw new LabError('VALIDATION_FAILED', 'No such request in history.');
    if (s.sim.evidence.includes(id)) return { message: 'Already in the evidence locker.' };
    if (s.sim.evidence.length >= 20) bad('The evidence locker holds at most 20 items.');
    s.sim.evidence.push(id); return { message: `Request ${id} saved to the evidence locker.` };
  } },
  'evidence.remove': { kind: 'meta', run: ({ s, p }) => { s.sim.evidence = s.sim.evidence.filter((e: string) => e !== p.historyId); return { message: 'Removed from evidence.' }; } },

  'settings.setMode': { kind: 'meta', run: ({ s, p }) => {
    const mode = oneOf(p.mode, ['beginner', 'intermediate', 'advanced'] as const, 'mode');
    s.mode = mode;
    return { message: `Guidance mode set to ${mode}.` };
  } },

  'hint.request': { kind: 'meta', run: ({ s, p }) => {
    const o = OBJECTIVE[str(p.objectiveId, 'objectiveId', 40)]; if (!o) throw new LabError('VALIDATION_FAILED', 'Unknown objective.');
    if (o.level > s.level) throw new LabError('LAB_ACTION_UNSUPPORTED', 'That objective is not unlocked yet.');
    const n = s.sim.hints[o.id] || 0;
    if (n >= o.hints.length) return { message: 'No further hints for this objective.' };
    s.sim.hints[o.id] = n + 1;
    return { message: 'Hint revealed.', result: { hint: o.hints[n], index: n + 1, total: o.hints.length } };
  } },

  'report.submit': { kind: 'change', run: ({ s, p }) => {
    if (s.level < 4) throw new LabError('LAB_ACTION_UNSUPPORTED', 'The report unlocks at Level 4 (after remediation & verification).');
    if (s.sim.report) throw new LabError('LAB_ACTION_UNSUPPORTED', 'The report has already been submitted.');
    const summary = str(p.summary, 'summary', 6000);
    if (summary.trim().length < 80) bad('The executive summary must be at least 80 characters.');
    // Optional per-finding severity selections (also settable at report time).
    if (p.severities && typeof p.severities === 'object') {
      for (const [id, sev] of Object.entries(p.severities)) { const fsr = s.sim.findings[id]; if (fsr && fsr.reported) fsr.reportedSeverity = oneOf(sev, SEVERITIES, 'severity'); }
    }
    const input = { summary };
    s.sim.report = { input, score: scoreReport(s, input), at: simTime(s) };
    s.sim.completedAt = simTime(s);
    timeline(s, 'story', 'Penetration-test report submitted. Engagement complete.');
    return { message: 'Report submitted. The engagement is complete.' };
  } },
};

function reqFromParams(r: any): HttpRequest {
  if (!r || typeof r !== 'object') bad('A request object is required.');
  const method = oneOf((r.method || 'GET').toUpperCase(), ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const, 'method');
  const headers: Record<string, string> = {};
  if (r.headers && typeof r.headers === 'object') for (const [k, v] of Object.entries(r.headers)) headers[String(k).toLowerCase()] = String(v).slice(0, 2000);
  const cookies: Record<string, string> = {};
  if (r.cookies && typeof r.cookies === 'object') for (const [k, v] of Object.entries(r.cookies)) cookies[String(k)] = String(v).slice(0, 4000);
  let path = str(r.path || '/', 'path', 2000); let query = r.query ? str(r.query, 'query', 2000) : '';
  if (path.includes('?') && !query) { const qi = path.indexOf('?'); query = path.slice(qi + 1); path = path.slice(0, qi); }
  return { method, path, query, headers, cookies, body: r.body ? str(r.body, 'body', 16000) : '' };
}

const pubRes = (res: HttpResponse) => ({ status: res.status, statusText: res.statusText, headers: res.headers, body: res.body, contentType: res.contentType, timeMs: res.timeMs });

// ---------- objectives / levels / chapters ----------
function recompute(s: any, causedBy: string) {
  for (const o of OBJECTIVES) {
    const st = (s.sim.objectives[o.id] ||= { done: false });
    const d = o.level <= s.level && o.done(s);
    if (d && !st.done) { st.done = true; st.at = simTime(s); }
    if (!d) st.done = st.done && o.kind === 'report' ? st.done : d; // report stays once set; others reflect live state but we keep confirmed/verified sticky via finding flags
    if (d) st.done = true;
  }
  while (s.level < 4 && OBJECTIVES.filter(o => o.level === s.level).every(o => s.sim.objectives[o.id]?.done)) {
    s.level++; timeline(s, 'story', `Level ${s.level - 1} complete. Level ${s.level} unlocked.`);
  }
  const ch = CHAPTERS.filter(c => c.when(s)).pop();
  if (ch && ch.n > s.chapter) { s.chapter = ch.n; timeline(s, 'story', `Chapter ${ch.n}: ${ch.title} — ${ch.text}`); }
}

function score(s: any) {
  const cats: Record<string, { got: number; max: number }> = {};
  const per: Record<string, number> = {};
  const add = (c: string, g: number, m: number) => { (cats[c] ||= { got: 0, max: 0 }); cats[c].got += g; cats[c].max += m; };
  for (const o of OBJECTIVES) {
    const factor = 1 - 0.25 * Math.min(2, s.sim.hints[o.id] || 0);
    let base = 0;
    if (o.id === 'L4.report') base = s.sim.report ? (s.sim.report.score.total / s.sim.report.score.max) * o.points : 0;
    else if (s.sim.objectives[o.id]?.done) base = o.points;
    else if (o.kind === 'fix' && s.sim.findings[o.finding!]?.remediated) base = o.points * 0.5;
    const awarded = Math.round(base * factor * 10) / 10;
    per[o.id] = awarded; add(o.category, awarded, o.points);
  }
  const penalties = [
    { label: 'Unsupported finding reports', points: Math.min(6, s.sim.wrongReports) },
    { label: 'Incorrect remediation attempts', points: Math.min(6, s.sim.wrongFixes) },
  ].filter(p => p.points);
  const raw = Object.values(cats).reduce((n, c) => n + c.got, 0);
  const max = Object.values(cats).reduce((n, c) => n + c.max, 0);
  const total = Math.max(0, Math.round((raw - penalties.reduce((n, p) => n + p.points, 0)) * 10) / 10);
  for (const c of Object.values(cats)) { c.got = Math.round(c.got * 10) / 10; }
  return { total, max, percent: max ? Math.round((total / max) * 100) : 0, categories: cats, penalties, perObjective: per };
}

// ---------- public projections ----------
function findingPublic(s: any, f: typeof FINDINGS[number]) {
  const fsr = s.sim.findings[f.id];
  const status = fsr.verified ? 'Verified' : fsr.remediated ? 'Remediated — unverified' : fsr.reported ? 'Documented' : fsr.confirmed ? 'Confirmed' : 'Not found';
  const base: any = { id: f.id, title: f.title, status, confirmed: fsr.confirmed, reported: fsr.reported, remediated: fsr.remediated, verified: fsr.verified };
  if (fsr.confirmed) {
    // The reference severity is graded ("Severity accuracy"), so it is only sent once the learner
    // has documented their own rating.
    if (fsr.reported) { base.severity = f.severity; base.severityWhy = f.severityWhy; }
    base.cwe = f.cwe; base.owasp = f.owasp;
    base.routes = f.routes; base.impact = f.impact; base.confirmedAt = fsr.confirmedAt;
    base.proof = fsr.proof ? { method: fsr.proof.method, path: fsr.proof.path, query: fsr.proof.query } : null;
    // remediation options WITHOUT the answer key:
    base.options = f.options.map(o => ({ id: o.id, label: o.label }));
    base.verifyRetest = f.verifyRetest;
  }
  if (fsr.reported) { base.reportedSeverity = fsr.reportedSeverity; base.affectedRoute = fsr.affectedRoute; base.note = fsr.note; }
  if (fsr.verified) { base.rootCause = f.rootCause; base.remediation = f.remediation; base.verifiedAt = fsr.verifiedAt; }
  return base;
}

// Guidance projection — beginner gets the full server-only walkthrough; intermediate a one-line
// level tip; advanced nothing. The step details (with payloads) leave the server only for beginner.
function buildGuidance(s: any) {
  const mode: GuideMode = s.mode || 'beginner';
  if (mode === 'beginner') {
    const steps = GUIDE_STEPS.map(g => ({ id: g.id, level: g.level, tool: g.tool, title: g.title, detail: g.detail, why: STEP_WHY[g.id] || '', done: g.done(s), prefill: PREFILL[g.id] || null }));
    const currentIndex = steps.findIndex(st => !st.done);
    return { mode, total: steps.length, completed: steps.filter(st => st.done).length, currentIndex, steps, level: s.level, levelWhy: LEVEL_WHY[Math.min(s.level, 4) - 1] };
  }
  if (mode === 'intermediate') return { mode, tip: LEVEL_TIPS[Math.min(s.level, 4) - 1] };
  return { mode };
}

export const webLab: LabEngine = {
  labId: 'TR-RED-001', title: 'The Breach Files — AeroCart',
  definition: () => ({
    id: 'TR-RED-001', title: 'The Breach Files — AeroCart',
    subtitle: 'Investigate, exploit, remediate and report on a vulnerable e-commerce application.',
    category: 'Red Team / Web Application Security',
    briefing: BRIEFING,
    target: { name: fx.TARGET_NAME, host: TARGET_HOST },
    vulnerabilities: FINDINGS.map(f => ({ id: f.id, title: f.title })),
    severities: SEVERITIES,
    terminalCommands: SUPPORTED_COMMANDS,
    modes: GUIDE_MODES,
  }),
  createInitialState(mode?: string) {
    const target = fx.createTargetState();
    const s: any = {
      mode: (['beginner', 'intermediate', 'advanced'] as const).includes(mode as any) ? mode : 'beginner',
      target,
      browser: { cookies: {}, url: '/', history: [] } as fx.BrowserState,
      proxy: { intercepting: false, held: null },
      terminal: initTermFs(),
      history: [], seqReq: 0,
      clock: { start: '2026-10-15T09:00:00Z', minutes: 0 },
      level: 1, chapter: 0, rev: 0,
      events: [], eventSeq: 0,
      sim: {
        acknowledged: false,
        findings: Object.fromEntries(FINDINGS.map(f => [f.id, { confirmed: false, reported: false, remediated: false, verified: false }])),
        objectives: {},
        recon: { robots: false, routes: 0, routeSet: {}, apiSeen: false, adminSeen: false, filesSeen: false, sourceSeen: false },
        evidence: [], hints: {}, signals: {}, inspected: {}, timeline: [],
        wrongReports: 0, wrongFixes: 0, failedActions: 0,
        report: null, completedAt: null,
      },
    };
    recompute(s, 'lab start');
    const c = CHAPTERS[0]; timeline(s, 'story', `Chapter ${c.n}: ${c.title} — ${c.text}`);
    return s;
  },
  dispatch(state, action) {
    const h = typeof action.type === 'string' && Object.prototype.hasOwnProperty.call(H, action.type) ? H[action.type] : undefined;
    const fail = (code: string, message: string) => {
      const s = clone(state); s.sim.failedActions++;
      s.events.push({ seq: ++s.eventSeq, at: simTime(s), type: action.type, outcome: code, message });
      if (s.events.length > 500) s.events.shift();
      return { state: s, result: { ok: false, code, message } };
    };
    if (!h) return fail('LAB_ACTION_UNSUPPORTED', 'Unknown action.');
    if (state.sim.report && (h.kind === 'change' || h.kind === 'nav' || h.kind === 'test')) return fail('LAB_ACTION_UNSUPPORTED', 'The engagement is complete. Reset the lab to start a new run.');
    const s = clone(state);
    let out;
    try { out = h.run({ s, p: action.params && typeof action.params === 'object' ? action.params : {} }); }
    catch (e) { if (e instanceof LabError) return fail(e.code, e.message); throw e; }
    s.rev++;
    s.clock.minutes += h.kind === 'change' ? 3 : h.kind === 'test' || h.kind === 'nav' ? 1 : 1;
    if (action.type !== 'inspect') { s.events.push({ seq: ++s.eventSeq, at: simTime(s), type: action.type, outcome: 'Success', message: out.message }); if (s.events.length > 500) s.events.shift(); }
    recompute(s, action.type);
    return { state: s, result: { ok: true, message: out.message, result: out.result } };
  },
  view(state) {
    const s = state;
    return {
      rev: s.rev, time: simTime(s), level: s.level,
      target: { name: fx.TARGET_NAME, host: TARGET_HOST },
      browser: { url: s.browser.url, cookies: s.browser.cookies, history: s.browser.history.slice(-30) },
      proxy: { intercepting: s.proxy.intercepting, held: s.proxy.held ? { request: s.proxy.held.request } : null },
      terminal: { cwd: s.terminal.cwd },
      history: s.history.slice(-120).map((h: any) => ({ id: h.id, at: h.at, tool: h.tool,
        request: { method: h.request.method, path: h.request.path, query: h.request.query, headers: h.request.headers, cookies: h.request.cookies, body: h.request.body },
        response: pubRes(h.response), events: h.events })),
    };
  },
  status(state) {
    const s = state; const sc = score(s);
    return {
      level: s.level, chapter: s.chapter, acknowledged: s.sim.acknowledged,
      mode: s.mode || 'beginner', guidance: buildGuidance(s),
      chapters: CHAPTERS.filter(c => c.n <= s.chapter).map(c => ({ n: c.n, title: c.title, text: c.text })),
      time: simTime(s), minutes: s.clock.minutes, complete: !!s.sim.report, rev: s.rev,
      objectives: OBJECTIVES.map(o => ({ id: o.id, level: o.level, title: o.level <= s.level ? o.title : 'Locked objective', locked: o.level > s.level, done: !!s.sim.objectives[o.id]?.done, points: o.points, awarded: sc.perObjective[o.id], category: o.category, kind: o.kind, finding: o.finding, hints: o.hints.slice(0, s.sim.hints[o.id] || 0), hintsRemaining: o.level <= s.level ? o.hints.length - (s.sim.hints[o.id] || 0) : 0 })),
      findings: FINDINGS.map(f => findingPublic(s, f)),
      recon: { routes: s.sim.recon.routes, robots: s.sim.recon.robots, apiSeen: s.sim.recon.apiSeen, adminSeen: s.sim.recon.adminSeen, filesSeen: s.sim.recon.filesSeen },
      evidence: s.sim.evidence.map((id: string) => { const h = s.history.find((x: any) => x.id === id); return h ? { id, at: h.at, tool: h.tool, method: h.request.method, path: h.request.path, status: h.response.status } : null; }).filter(Boolean),
      score: sc, timeline: s.sim.timeline,
      posture: { confirmed: FINDINGS.filter(f => s.sim.findings[f.id].confirmed).length, documented: FINDINGS.filter(f => s.sim.findings[f.id].reported).length, verified: FINDINGS.filter(f => s.sim.findings[f.id].verified).length, total: FINDINGS.length },
      progress: Math.round((OBJECTIVES.filter(o => s.sim.objectives[o.id]?.done).length / OBJECTIVES.length) * 100),
      hintsUsed: Object.values<number>(s.sim.hints).reduce((a, b) => a + b, 0), failedActions: s.sim.failedActions,
      reportSubmitted: !!s.sim.report,
    };
  },
  report(state, meta) {
    const s = state; const sc = score(s);
    const ev = (id: string) => { const h = s.history.find((x: any) => x.id === id); return h ? { id, tool: h.tool, at: h.at, method: h.request.method, path: h.request.path + (h.request.query ? '?' + h.request.query : ''), status: h.response.status } : null; };
    return {
      meta: { ...meta, lab: 'TR-RED-001 — The Breach Files (AeroCart)', generatedAt: new Date().toISOString(), simulatedTime: simTime(s), final: !!s.sim.report, simulatedMinutes: s.clock.minutes, level: s.level },
      disclosure: 'This assessment was performed in a controlled ThreatReady training simulation against a synthetic target (AeroCart). No real company, customer, credential or production system was involved.',
      scope: BRIEFING.scope, outOfScope: BRIEFING.outOfScope, methodology: ['Reconnaissance & attack-surface mapping', 'Exploitation & proof of impact', 'Remediation & verification re-testing', 'Reporting'],
      summary: {
        learnerText: s.sim.report?.input.summary || null,
        confirmed: FINDINGS.filter(f => s.sim.findings[f.id].confirmed).length,
        documented: FINDINGS.filter(f => s.sim.findings[f.id].reported).length,
        verified: FINDINGS.filter(f => s.sim.findings[f.id].verified).length,
        total: FINDINGS.length,
      },
      findings: FINDINGS.map(f => { const fsr = s.sim.findings[f.id]; return {
        id: f.id, title: f.title, severity: fsr.reported ? fsr.reportedSeverity : (fsr.confirmed && s.sim.report ? f.severity : '—'),
        trueSeverity: fsr.confirmed && (fsr.reported || s.sim.report) ? f.severity : '—', cwe: f.cwe, owasp: f.owasp,
        status: fsr.verified ? 'Verified fixed' : fsr.remediated ? 'Remediated (unverified)' : fsr.reported ? 'Documented' : fsr.confirmed ? 'Confirmed' : 'Not found',
        affected: fsr.affectedRoute || f.routes.join(', '),
        confirmed: fsr.confirmed, confirmedAt: fsr.confirmedAt || null,
        impact: fsr.confirmed ? f.impact : null, rootCause: fsr.verified ? f.rootCause : null, remediation: fsr.verified ? f.remediation : null,
        reproduction: fsr.proof ? `${fsr.proof.method} ${fsr.proof.path}${fsr.proof.query ? '?' + fsr.proof.query : ''}` : null,
        analystNote: fsr.note || null,
        retest: fsr.verified ? 'Re-test passed — not reproducible after remediation.' : fsr.remediated ? 'Remediated but re-test not passed.' : 'Not retested.',
      }; }),
      evidence: s.sim.evidence.map(ev).filter(Boolean),
      timeline: s.sim.timeline,
      remainingRisks: FINDINGS.filter(f => !s.sim.findings[f.id].verified).map(f => s.sim.findings[f.id].confirmed ? `${f.id} ${f.title}: ${s.sim.findings[f.id].remediated ? 'remediated but unverified' : 'open'}` : `${f.id} ${f.title}: not demonstrated`),
      reportAssessment: s.sim.report ? s.sim.report.score : null,
      performance: { score: sc, hintsUsed: Object.values<number>(s.sim.hints).reduce((a, b) => a + b, 0), failedActions: s.sim.failedActions, unsupportedReports: s.sim.wrongReports, wrongFixes: s.sim.wrongFixes, actions: s.events.length },
      limitations: ['A scripted simulation: it exercises the intended vulnerability classes only and cannot surface unscripted bugs or arbitrary exploit chains.', 'No real tooling engine runs; tools are faithful simulations of Burp-style and CLI workflows.'],
    };
  },
};
