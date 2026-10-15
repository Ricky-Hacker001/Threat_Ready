// Per-case log stream: history generated at case start, then one-second
// slots generated as wall-clock time passes. Everything is derived from
// (seed, t0, executed response actions), so the stream is reproducible.

import { noiseSlot } from './noise.js';
import { deriveState } from './response.js';
import { parseQuery, matches } from './query.js';
import { hostNameAt } from './env.js';
import { rng } from './rng.js';

const MAX_LIVE_SECONDS = 6 * 3600;

export class LogStream {
  constructor(c, scenario, alias = null) {
    this.c = c;
    this.scenario = scenario;
    this.t0 = c.t0;
    this.events = [];
    this.index = new Map();
    this.seq = 0;
    this.injected = 0;
    // Level attempts: searches and sweeps match what the analyst sees.
    this.alias = alias && alias.pairs?.length ? alias : null;

    const variant = c.variant && !c.variant.canonical ? c.variant : null;
    const built = scenario.build({ t0: c.t0, seed: c.seed, variant, level: c.level });
    // Uniform timing stretch for modules that declare it (no periodic
    // events depend on their offsets). Never earlier than the history window.
    if (variant && scenario.jitter?.timing && scenario.scaleTiming) {
      const r = rng(c.seed, 'timing');
      let f = 1 + (r.f() * 2 - 1) * scenario.jitter.timing;
      const earliest = Math.min(0, ...built.events.map((e) => e.ts - c.t0));
      if (earliest < 0) f = Math.min(f, ((scenario.historySeconds - 5) * 1000) / -earliest);
      for (const ev of built.events) ev.ts = Math.round(c.t0 + (ev.ts - c.t0) * f);
    }
    this.noiseOpts = { sources: scenario.catalog?.sources || [], heavy: c.level === 'expert' && !c.variant?.canonical };
    this.periodic = built.periodic || [];
    this.sched = new Map();
    for (const ev of built.events) {
      const slot = Math.floor((ev.ts - this.t0) / 1000);
      if (!this.sched.has(slot)) this.sched.set(slot, []);
      this.sched.get(slot).push(ev);
    }
    this.nextSlot = -scenario.historySeconds;
    this.ensure();
  }

  slotOf(ts) {
    return Math.floor((ts - this.t0) / 1000);
  }

  insert(ev) {
    ev.seq = ++this.seq;
    ev._lc = ev.raw.toLowerCase();
    if (this.alias) {
      ev._lca = this.alias.out(ev.raw).toLowerCase();
      const fa = {};
      for (const [k, v] of Object.entries(ev.fields)) fa[k] = typeof v === 'string' ? this.alias.out(v) : v;
      ev._fa = fa;
    }
    const a = this.events;
    let i = a.length;
    while (i > 0 && a[i - 1].ts > ev.ts) i--;
    if (i === a.length) a.push(ev);
    else a.splice(i, 0, ev);
    this.index.set(ev.id, ev);
  }

  genSlot(s) {
    const slotTs = this.t0 + s * 1000;
    const state = s >= 0 ? deriveState(this.c.actions, slotTs) : deriveState([]);
    const isOffline = (ev) => {
      if (!state.isolated.size) return false;
      const f = ev.fields;
      for (const cand of [ev.host, f.workstation, hostNameAt(f.src_ip), hostNameAt(f.client_ip)]) {
        if (cand && state.offline(cand)) return true;
      }
      return false;
    };
    const evs = noiseSlot(this.c.seed, s, this.t0, this.noiseOpts).filter((e) => !isOffline(e));
    const sched = this.sched.get(s);
    if (sched) evs.push(...sched);
    for (const p of this.periodic) {
      const k0 = Math.floor((s - p.start) / p.period);
      for (let k = Math.max(0, k0 - 1); k <= k0 + 1; k++) {
        if (p.count !== undefined && k >= p.count) continue;
        const jr = rng(this.c.seed, 'periodic', p.key, k);
        const off = p.start + k * p.period + (jr.f() * 2 - 1) * (p.jitter || 0);
        if (Math.floor(off) !== s) continue;
        const made = p.make({ k, ts: this.t0 + Math.round(off * 1000), state, r: jr }) || [];
        for (const e of made) { e._tags = e._tags || p.tags || []; evs.push(e); }
      }
    }
    evs.sort((x, y) => x.ts - y.ts);
    const code = (s + 2_000_000).toString(36);
    evs.forEach((e, i) => {
      e.id = `${code}${i.toString(36)}`;
      this.insert(e);
    });
  }

  // Generate every slot that has fully elapsed.
  ensure(now = Date.now()) {
    const end = this.c.closedAt ?? now;
    let target = Math.min(this.slotOf(Math.min(now, end)) - 1, MAX_LIVE_SECONDS);
    while (this.nextSlot <= target) this.genSlot(this.nextSlot++);
    while (this.injected < this.c.injected.length) {
      const src = this.c.injected[this.injected++];
      this.insert({ ...src, fields: { ...src.fields } });
    }
  }

  get(id) {
    return this.index.get(id);
  }

  since(seq) {
    const out = [];
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.seq > seq) out.push(e);
      // Events are time-ordered, not seq-ordered, but late inserts land within
      // a second or two of the tail, so a bounded look-back is sufficient.
      if (this.events.length - i > 400) break;
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  query({ q = '', source, from, to, limit = 100, offset = 0, order = 'desc' } = {}) {
    const terms = parseQuery(q);
    const srcs = source ? new Set(String(source).split(',').filter(Boolean)) : null;
    const hits = [];
    for (const e of this.events) {
      if (srcs && !srcs.has(e.source)) continue;
      if (from !== undefined && e.ts < from) continue;
      if (to !== undefined && e.ts > to) continue;
      if (terms.length && !matches(terms, e)) continue;
      hits.push(e);
    }
    const total = hits.length;
    if (order !== 'asc') hits.reverse();
    const bySource = {};
    for (const e of hits) bySource[e.source] = (bySource[e.source] || 0) + 1;
    return { total, bySource, events: hits.slice(offset, offset + limit) };
  }
}

// Strip everything the analyst must not see. (Level attempts are renamed
// on the way out by the route layer.)
export function publicEvent(e) {
  return { id: e.id, ts: e.ts, source: e.source, host: e.host, raw: e.raw, fields: e.fields };
}
