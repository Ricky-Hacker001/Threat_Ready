// Server-side worked tickets for the homepage walkthrough.
//
// The walkthrough explains the console without the learner starting
// anything, so the server prepares read-only sample tickets at four points
// of the workflow. They use the demo scenario only, live in memory only,
// are never listed with cases, and reject every change.

import { getScenario } from '../scenarios/index.js';
import { HttpError } from '../engine/response.js';
import {
  createCase, getCase, streamFor, tick, acknowledge, pinEvent, tool, action, submit, dropPreview,
} from '../engine/cases.js';

export const DEMO_SCENARIO = 'demo-portal-login';
const NOTE = 'Sample entry written by the walkthrough preview so that this screen has something to show. In your own ticket this is where your own words go.';

// Fill the current form stage from the scenario's answer key.
export function solveStage(c, scn, stageId) {
  const def = scn.stages.find((s) => s.id === stageId);
  const stream = streamFor(c);
  const tagged = (tags) => stream.events.filter((e) => (e._tags || []).some((x) => tags.includes(x)));
  const pin = (ev) => {
    if (!c.pins.some((p) => p.eventId === ev.id)) pinEvent(c, ev.id, '');
    return ev.id;
  };
  for (const [id, input] of scn._test?.tools?.[stageId] || []) tool(c, id, { input });
  const values = {};
  const links = {};
  for (const f of def.fields) {
    const k = f.key || {};
    switch (f.type) {
      case 'single': case 'host': case 'account':
        values[f.id] = typeof k.accept === 'string' ? k.accept : Object.entries(k.accept).find(([, cr]) => cr >= 1)[0];
        break;
      case 'multi': case 'hosts': case 'accounts': values[f.id] = [...k.set]; break;
      case 'text': values[f.id] = k.accept[0]; break;
      case 'longtext': values[f.id] = NOTE; break;
      case 'order': values[f.id] = [...k.order]; break;
      case 'pins':
        // Newest first, so the pins are among the events the alert itself lists.
        values[f.id] = Object.values(k.groups).map((tags) => pin(tagged(tags).slice(-1)[0]));
        break;
      case 'pin_one': {
        const ranked = Object.entries(k.accept).sort((a, b) => b[1] - a[1]);
        const ev = ranked.map(([tag]) => tagged([tag])[0]).find(Boolean);
        values[f.id] = ev ? pin(ev) : c.pins[0]?.eventId;
        break;
      }
      case 'ioc_list':
        values[f.id] = [...k.must, ...(k.valid || []).filter((v) => !k.must.includes(v)).slice(0, k.wantExtra ?? 2)].map((value) => ({ type: 'ip', value }));
        break;
      default: break;
    }
    if (f.linkable) links[f.id] = [pin(tagged(k.support)[0])];
  }
  return { values, links };
}

const POINTS = ['l1', 'l2', 'l3', 'closed'];
const STOP_AT = { l1: 'l1_triage', l2: 'l2_investigation', l3: 'l3_response', closed: null };

function build(point) {
  const scn = getScenario(DEMO_SCENARIO);
  const c = createCase({ scenarioId: DEMO_SCENARIO, analyst: 'sample', kind: 'preview', backdateSeconds: 150 });
  tick(c);
  acknowledge(c);
  if (point === 'l1') {
    // Two of the events the alert already lists, so Evidence is not empty.
    const stream = streamFor(c);
    for (const tag of ['atk_fail', 'atk_ok']) {
      const ev = stream.events.filter((e) => (e._tags || []).includes(tag)).slice(-1)[0];
      if (ev) pinEvent(c, ev.id, '');
    }
  }
  let guard = 0;
  while (c.status === 'open' && c.stage !== STOP_AT[point] && guard++ < 20) {
    const def = scn.stages.find((s) => s.id === c.stage);
    if (def.kind === 'response') {
      for (const a of scn._test.actions) action(c, { ...a, confirm: true });
      submit(c, {});
    } else {
      submit(c, { ...solveStage(c, scn, def.id), finalize: true });
    }
  }
  c.readOnly = true;
  return c;
}

const TTL = 20 * 60 * 1000;
const live = new Map(); // point -> [{ id, at }] newest last

export function previewFor(point) {
  if (!POINTS.includes(point)) throw new HttpError(400, 'Unknown preview.');
  const now = Date.now();
  const list = live.get(point) || [];
  // Retire old previews, but keep the previous one for anyone still on it.
  while (list.length && now - list[0].at > 2 * TTL) dropPreview(list.shift().id);
  let cur = list[list.length - 1];
  if (!cur || now - cur.at > TTL) {
    const c = build(point);
    cur = { id: c.id, at: now };
    list.push(cur);
    while (list.length > 2) dropPreview(list.shift().id);
  }
  live.set(point, list);
  return { id: cur.id, point, readOnly: true, ticket: getCase(cur.id).ticket };
}
