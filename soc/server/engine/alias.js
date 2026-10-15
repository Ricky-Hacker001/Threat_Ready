// Per-attempt renaming (Build specification, section 6.2).
//
// Scenarios keep writing logs with canonical names. An alias map built from
// the attempt seed renames every entity consistently wherever the analyst
// can see it (out), and maps what the analyst types back to canonical form
// before the engine uses it (in). Answer keys therefore never change.
//
// Renamed: human user accounts and display names, every host name and
// internal address in the environment, the scenario's external domains,
// external addresses and identifiers (change and ticket ids, attacker host
// names), and every SHA-256 (a keyed, reversible digit shift).

import { rng } from './rng.js';
import { ACCOUNTS, HOSTS, ORG } from './env.js';
import { FIRST_NAMES, SURNAMES, DOMAIN_WORDS, DOMAIN_TLDS, BRAND_BLOCKLIST, EXTERNAL_BLOCKS } from './pools.js';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HEX = '0123456789abcdef';

function caseLike(sample, alias) {
  if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return alias.toUpperCase();
  if (sample === sample.toLowerCase() && sample !== sample.toUpperCase()) return alias.toLowerCase();
  return alias;
}

export class AliasMap {
  constructor(pairs, hashKey) {
    this.pairs = pairs; // [canonical, alias]
    this.fwd = new Map(pairs.map(([c, a]) => [c.toLowerCase(), a]));
    this.rev = new Map(pairs.map(([c, a]) => [a.toLowerCase(), c]));
    this.canon = new Set(pairs.map(([c]) => c.toLowerCase()));
    this.hashKey = hashKey;
    const build = (list) => {
      const sorted = [...list].sort((a, b) => b.length - a.length).map(esc);
      return sorted.length ? new RegExp(`(?<![A-Za-z0-9_-])(?:${sorted.join('|')})(?![A-Za-z0-9_-]|\\.\\d)`, 'gi') : null;
    };
    this.reOut = build(pairs.map(([c]) => c));
    this.reIn = build([...pairs.map(([, a]) => a), ...pairs.map(([c]) => c)]);
  }

  shiftHash(h, dir) {
    let s = '';
    const lower = h.toLowerCase();
    for (let i = 0; i < 64; i++) s += HEX[(HEX.indexOf(lower[i]) + dir * this.hashKey[i] + 16) % 16];
    return s;
  }

  out(str) {
    if (typeof str !== 'string' || !str) return str;
    let s = this.reOut ? str.replace(this.reOut, (m) => caseLike(m, this.fwd.get(m.toLowerCase()) ?? m)) : str;
    s = s.replace(/(?<![A-Za-z0-9])[a-fA-F0-9]{64}(?![A-Za-z0-9])/g, (h) => this.shiftHash(h, 1));
    return s;
  }

  // Alias -> canonical. A canonical name typed directly (never shown in this
  // attempt) is neutralised so it cannot be used to answer.
  in(str) {
    if (typeof str !== 'string' || !str) return str;
    let s = this.reIn ? str.replace(this.reIn, (m) => {
      const k = m.toLowerCase();
      if (this.rev.has(k)) return caseLike(m, this.rev.get(k));
      if (this.canon.has(k)) return `${m}-not-in-this-attempt`;
      return m;
    }) : str;
    s = s.replace(/(?<![A-Za-z0-9])[a-fA-F0-9]{64}(?![A-Za-z0-9])/g, (h) => this.shiftHash(h, -1));
    return s;
  }

  outDeep(v) { return walk(v, (s) => this.out(s), null); }
  inDeep(v, skip = SKIP_IN) { return walk(v, (s) => this.in(s), skip); }
  toJSON() { return { pairs: this.pairs }; }
}

// Keys whose values are engine identifiers, not analyst-visible names.
const SKIP_IN = new Set(['eventId', 'links', 'id', 'stageId', 'fieldId', 'type', 'confirm', 'finalize', 'beat']);
function walk(v, fn, skip, key) {
  if (skip && key !== undefined && skip.has(key)) return v;
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, fn, skip));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x, fn, skip, k);
    return o;
  }
  return v;
}

export const IDENTITY = {
  out: (s) => s, in: (s) => s, outDeep: (v) => v, inDeep: (v) => v, pairs: [],
};

// Build the map for one attempt. `entities` comes from the scenario module:
// { domains: [...], ips: [...], ids: [...], names: [...] } (all canonical).
export function buildAlias(seed, entities = {}) {
  const r = rng('alias', seed);
  const used = new Set();
  const canonicalTokens = new Set();
  for (const a of ACCOUNTS) { canonicalTokens.add(a.sam.toLowerCase()); if (a.name) canonicalTokens.add(a.name.toLowerCase()); }
  for (const h of HOSTS) { canonicalTokens.add(h.name.toLowerCase()); canonicalTokens.add(h.ip); }
  for (const list of Object.values(entities)) for (const x of list || []) canonicalTokens.add(String(x).toLowerCase());
  const fresh = (make) => {
    for (let i = 0; i < 200; i++) {
      const v = make();
      const k = v.toLowerCase();
      if (!used.has(k) && !canonicalTokens.has(k)) { used.add(k); return v; }
    }
    throw new Error('alias pool exhausted');
  };
  const pairs = [];
  const add = (c, a) => { if (c && a && c.toLowerCase() !== a.toLowerCase()) pairs.push([c, a]); };

  // People: new first and last name; the account keeps the f.last format.
  const people = new Map();
  for (const a of ACCOUNTS.filter((x) => x.type === 'user')) {
    let first;
    let last;
    const sam = fresh(() => {
      first = r.pick(FIRST_NAMES);
      last = r.pick(SURNAMES);
      return `${first[0].toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}`;
    });
    const name = `${first} ${last}`;
    used.add(name.toLowerCase());
    people.set(a.sam, { sam, name });
    add(a.sam, sam);
    add(a.name, name);
  }
  for (const a of ACCOUNTS.filter((x) => x.type === 'admin' && x.of)) {
    const p = people.get(a.of);
    if (!p) continue;
    add(a.sam, fresh(() => `adm.${p.sam.replace('.', '')}`));
    add(a.name, `${p.name} (admin)`);
  }

  // Hosts and their addresses.
  const ipUsed = new Set(HOSTS.map((h) => h.ip));
  for (const h of HOSTS) {
    if (h.alias === false) continue;
    const ws = h.name.match(/^(WS-[A-Z]+-)(\d{3})$/);
    const srv = h.name.match(/^([A-Z][A-Z-]*?)(\d{2})$/);
    if (ws) add(h.name, fresh(() => `${ws[1]}${String(r.int(100, 899)).padStart(3, '0')}`));
    else if (srv) add(h.name, fresh(() => `${srv[1]}${String(r.int(12, 89))}`));
    if (/^10\.|^172\.16\./.test(h.ip)) {
      const pre = h.ip.split('.').slice(0, 3).join('.');
      let ip;
      for (let i = 0; i < 300; i++) { ip = `${pre}.${r.int(100, 249)}`; if (!ipUsed.has(ip)) break; }
      ipUsed.add(ip);
      add(h.ip, ip);
    }
  }

  // Scenario-specific external entities.
  const blocks = [...EXTERNAL_BLOCKS];
  for (const ip of entities.ips || []) {
    if (/^(10\.|172\.16\.|192\.168\.)/.test(ip)) {
      const pre = ip.split('.').slice(0, 3).join('.');
      add(ip, fresh(() => `${pre}.${r.int(100, 249)}`));
      continue;
    }
    const b = blocks.splice(r.int(0, blocks.length - 1), 1)[0];
    add(ip, fresh(() => `${b}.${r.int(2, 254)}`));
  }
  const word = () => { let w; do { w = r.pick(DOMAIN_WORDS); } while (BRAND_BLOCKLIST.some((x) => w.includes(x))); return w; };
  // Keep sub-labels (cdn., mail.), replace the registrable part (label + TLD).
  const regDomain = (d) => {
    const parts = d.split('.');
    const n = /\.example\.(com|net|org)$/.test(d) ? 3 : 2;
    return { reg: parts.slice(-n).join('.'), head: parts.slice(0, Math.max(0, parts.length - n)) };
  };
  const regMap = new Map();
  for (const d of entities.domains || []) {
    const { reg, head } = regDomain(String(d).toLowerCase());
    if (!regMap.has(reg)) {
      regMap.set(reg, fresh(() => `${word()}-${word()}.${r.pick(DOMAIN_TLDS)}`));
      add(reg, regMap.get(reg));
    }
    if (head.length) add(d, [...head, regMap.get(reg)].join('.'));
  }
  for (const id of entities.ids || []) {
    const m = String(id).match(/^([A-Za-z]+-?)(\d+)$/);
    add(id, fresh(() => (m ? `${m[1]}${String(r.int(10 ** (m[2].length - 1), 10 ** m[2].length - 1))}` : `${id}-${r.int(10, 99)}`)));
  }
  for (const n of entities.names || []) {
    if (/^AKIA[A-Z0-9]{16}$/.test(n)) { add(n, fresh(() => `AKIA${Array.from({ length: 16 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[r.int(0, 31)]).join('')}`)); continue; }
    const m = String(n).match(/^(.*?)([A-Z0-9]{4,})$/);
    add(n, fresh(() => (m ? `${m[1]}${Array.from({ length: m[2].length }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[r.int(0, 31)]).join('')}` : `${n}${r.int(10, 99)}`)));
  }
  const hashKey = Array.from({ length: 64 }, () => r.int(1, 15));
  return new AliasMap(pairs, hashKey);
}

export const ORG_NAME = ORG.name;
