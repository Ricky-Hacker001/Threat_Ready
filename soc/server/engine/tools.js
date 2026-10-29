// Analyst tools. Results are computed from the case's own log stream and
// the scenario's intelligence data; nothing here consults the answer key.

import { publicEvent } from './logstream.js';
import { HttpError } from './response.js';
import {
  WEB, BENIGN_DOMAINS, KNOWN_GOOD_HASHES, HOSTS, hostNamed, hostAt, account, ACCOUNTS, USERS, BASE_CHANGES, ORG,
} from './env.js';
import { norm } from './grading.js';

export const TOOLS = [
  { id: 'reputation', run: 'Look up', tier: 1, label: 'Threat intelligence', desc: 'Reputation, registration and passive DNS for a domain, IP or file hash.', input: 'Domain, IP address or SHA-256' },
  { id: 'asset', run: 'Look up host', tier: 1, label: 'Asset inventory', desc: 'Role, owner and criticality of a host.', input: 'Hostname or internal IP' },
  { id: 'user', run: 'Look up account', tier: 1, label: 'Directory', desc: 'Account type, group membership and normal logon pattern.', input: 'Account name' },
  { id: 'change', run: 'List changes', tier: 1, label: 'Change calendar', desc: 'Approved and scheduled changes. Leave the filter empty to list all.', input: 'Filter by host, owner or keyword (optional)', optional: true },
  { id: 'decode', run: 'Decode', tier: 1, label: 'Decode', desc: 'Base64 (UTF-8 or UTF-16LE), URL-encoding or hex to text.', input: 'Encoded string', multiline: true },
  { id: 'sweep', run: 'Run sweep', tier: 2, label: 'Fleet IOC sweep', desc: 'Every host and mailbox where an indicator appears, across all log sources.', input: 'Domain, IP, hash, file name or other string (min. 4 characters)' },
  { id: 'proctree', run: 'Build tree', tier: 2, label: 'Process tree', desc: 'Parent/child process ancestry for a host from endpoint telemetry.', input: 'Hostname', filter: 'Only branches containing (optional)' },
  { id: 'sandbox', run: 'Detonate', tier: 2, label: 'Sandbox detonation', desc: 'Behaviour report for a file by SHA-256.', input: 'SHA-256' },
];

const isIp = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s);
const isHash = (s) => /^[a-f0-9]{64}$/.test(s);
const fmtDate = (ts) => new Date(ts).toISOString().slice(0, 10);

function reputation(ctx, input) {
  const raw = String(input || '').trim();
  if (!raw) throw new HttpError(400, 'Enter a domain, IP address or SHA-256.');
  const h = norm.hash(raw);
  const type = isHash(h) ? 'sha256' : isIp(norm.ip(raw)) ? 'ip' : 'domain';
  const indicator = type === 'sha256' ? h : type === 'ip' ? norm.ip(raw) : norm.domain(raw);
  const intel = ctx.scenario.intel({ t0: ctx.c.t0 });
  const rec = intel[indicator];
  if (rec) return { kind: 'reputation', indicator, type, ...rec };

  if (type === 'ip') {
    const host = hostAt(indicator);
    if (host || /^(10\.|172\.16\.|192\.168\.|127\.)/.test(indicator)) {
      return { kind: 'reputation', indicator, type, verdict: 'internal', detections: 'n/a', facts: [['Scope', 'Private address (RFC 1918)'], ['Asset', host ? `${host.name} - ${host.role}` : 'Not in asset inventory']], notes: ['Internal addresses have no external reputation. Use the asset inventory.'] };
    }
    const w = WEB.find((x) => x[1] === indicator);
    if (w) return { kind: 'reputation', indicator, type, verdict: 'clean', detections: '0/89', facts: [['Resolves from', w[0]], ['Category', w[2]], ['First seen', 'More than 5 years ago']], notes: ['Established infrastructure with no malicious reports.'] };
  }
  if (type === 'domain') {
    const w = WEB.find((x) => x[0] === indicator) || WEB.find((x) => indicator.endsWith(`.${x[0].split('.').slice(-2).join('.')}`) || x[0].endsWith(`.${indicator}`));
    if (w || indicator.endsWith(ORG.mailDomain)) {
      return { kind: 'reputation', indicator, type, verdict: 'clean', detections: '0/89', facts: [['Category', w ? w[2] : 'Corporate (own domain)'], ['Registered', 'More than 5 years ago'], ['Prevalence', 'High - seen daily across the organisation']], notes: ['Established domain with no malicious reports.'] };
    }
  }
  if (type === 'sha256' && KNOWN_GOOD_HASHES.has(indicator)) {
    const b = KNOWN_GOOD_HASHES.get(indicator);
    return { kind: 'reputation', indicator, type, verdict: 'clean', detections: '0/72', facts: [['File', b.path.split('\\').pop()], ['Signer', `${b.signer} (valid)`], ['Prevalence', 'Very high - known operating system or vendor binary']], notes: ['Known-good signed binary. Whether its use was legitimate depends on how it was invoked.'] };
  }
  return { kind: 'reputation', indicator, type, verdict: 'unknown', detections: type === 'sha256' ? '0/72' : '0/89', facts: [['Records', 'None']], notes: ['No intelligence records for this indicator. Absence of a record is not evidence that it is safe.'] };
}

function asset(ctx, input) {
  const v = String(input || '').trim();
  if (!v) throw new HttpError(400, 'Enter a hostname or internal IP.');
  const extraRec = ctx.scenario.assetRecords?.[v.toLowerCase()] || ctx.scenario.assetRecords?.[v];
  if (extraRec) return { kind: 'facts', title: v, found: true, facts: extraRec.facts, notes: extraRec.notes || [] };
  const h = hostNamed(v) || hostAt(v);
  if (!h) return { kind: 'facts', title: v, found: false, notes: ['No asset with that hostname or address.'] };
  const owner = ACCOUNTS.find((u) => u.sam === h.owner && u.type === 'user');
  const extra = (ctx.scenario.assetNotes && ctx.scenario.assetNotes[h.name]) || [];
  return {
    kind: 'facts', title: h.name, found: true,
    facts: [
      ['Role', h.role], ['IP address', h.ip], ['Network zone', h.vlan], ['Operating system', h.os],
      ['Business criticality', h.criticality], ['Owner', owner ? `${owner.name} (${owner.sam}), ${owner.title}` : h.owner],
      ['EDR agent', h.os.includes('ppliance') ? 'Not applicable' : 'Installed, reporting, policy: detect-only'],
    ],
    notes: [h.notes, ...extra].filter(Boolean),
  };
}

function user(ctx, input) {
  const v = String(input || '').trim();
  if (!v) throw new HttpError(400, 'Enter an account name.');
  const a = account(v) || ACCOUNTS.find((x) => x.name.toLowerCase() === v.toLowerCase());
  if (!a) return { kind: 'facts', title: v, found: false, notes: ['No account with that name.'] };
  const mgr = a.manager ? ACCOUNTS.find((u) => u.sam === a.manager) : null;
  const facts = [['Account', `${ORG.netbios}\\${a.sam}`], ['Type', a.type === 'user' ? 'User account' : a.type === 'service' ? 'Service account' : 'Privileged administrative account'], ['Name', a.name]];
  if (a.type === 'user') facts.push(['Title', a.title], ['Department', a.dept], ['Manager', mgr ? `${mgr.name} (${mgr.sam})` : '-'], ['Primary workstation', `${a.host} (${a.ip})`], ['Local administrator', a.localAdmin ? `Yes, on ${a.host}` : 'No'], ['Email', a.email]);
  else facts.push(['Normal logon sources', (a.usualHosts || []).join(', ') || '-']);
  facts.push(['Groups', a.groups.join(', ')]);
  if (a.disabled || ctx.scenario.accountState?.[a.sam]) facts.push(['Account status', ctx.scenario.accountState?.[a.sam] || 'Disabled']);
  const extra = (ctx.scenario.accountNotes && ctx.scenario.accountNotes[a.sam]) || [];
  return { kind: 'facts', title: a.sam, found: true, facts, notes: [a.notes, ...extra].filter(Boolean) };
}

function change(ctx, input) {
  const f = String(input || '').trim().toLowerCase();
  const all = [...BASE_CHANGES, ...(ctx.scenario.changes || [])].sort((a, b) => a.start - b.start);
  const t0 = ctx.c.t0;
  const items = all
    .filter((ch) => !f || [ch.id, ch.title, ch.scope, ch.owner, ch.detail].join(' ').toLowerCase().includes(f))
    .map((ch) => ({ id: ch.id, title: ch.title, scope: ch.scope, owner: ch.owner, status: ch.status, start: t0 + ch.start * 60000, end: t0 + ch.end * 60000, detail: ch.detail }));
  return { kind: 'change', filter: f, items };
}

function decode(ctx, input) {
  const text = String(input || '').trim();
  if (!text) throw new HttpError(400, 'Paste the string to decode.');
  const printable = (s) => s.length > 0 && [...s].filter((ch) => /[\x09\x0a\x0d\x20-\x7e -￿]/.test(ch)).length / s.length > 0.92;
  const compact = text.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) && compact.length >= 8 && compact.length % 4 !== 1) {
    const buf = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    let nul = 0;
    for (let i = 1; i < buf.length; i += 2) if (buf[i] === 0) nul++;
    if (buf.length >= 4 && nul / (buf.length / 2) > 0.7) {
      const out = buf.toString('utf16le');
      if (printable(out)) return { kind: 'decode', encoding: 'Base64 → UTF-16LE (PowerShell -EncodedCommand format)', output: out };
    }
    const out = buf.toString('utf8');
    if (printable(out) && !out.includes('�')) return { kind: 'decode', encoding: 'Base64 → UTF-8', output: out };
  }
  if (/%[0-9a-f]{2}/i.test(text)) {
    try { return { kind: 'decode', encoding: 'URL-encoded', output: decodeURIComponent(text) }; } catch { /* fall through */ }
  }
  const hex = compact.replace(/^0x/i, '');
  if (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0 && hex.length >= 8) {
    const out = Buffer.from(hex, 'hex').toString('utf8');
    if (printable(out)) return { kind: 'decode', encoding: 'Hex → UTF-8', output: out };
  }
  return { kind: 'decode', encoding: null, output: null, notes: ['The input is not Base64, URL-encoded or hex text that decodes to readable characters. Paste only the encoded value, without the surrounding command line.'] };
}

function sweep(ctx, input) {
  // Matches what the analyst sees (renamed text in level attempts).
  const needle = String(ctx.visibleInput ?? input ?? '').trim().toLowerCase();
  if (needle.length < 4) throw new HttpError(400, 'Enter at least 4 characters.');
  const rows = new Map();
  const hits = [];
  for (const e of ctx.stream.events) {
    if (!(e._lca ?? e._lc).includes(needle)) continue;
    hits.push(e);
    const f = e.fields;
    const entity = e.source === 'email' ? `Mailbox ${f.to}` : (f.src_host || e.host);
    if (!rows.has(entity)) rows.set(entity, { entity, count: 0, first: e.ts, last: e.ts, sources: {} });
    const r = rows.get(entity);
    r.count++;
    r.first = Math.min(r.first, e.ts);
    r.last = Math.max(r.last, e.ts);
    r.sources[e.source] = (r.sources[e.source] || 0) + 1;
  }
  return {
    kind: 'sweep', indicator: needle, total: hits.length,
    window: { from: ctx.stream.events[0]?.ts, to: ctx.stream.events[ctx.stream.events.length - 1]?.ts },
    rows: [...rows.values()].sort((a, b) => a.first - b.first),
    earliest: hits.slice(0, 5).map(publicEvent),
  };
}

function proctree(ctx, input, filter) {
  const h = hostNamed(String(input || '').trim());
  if (!h) throw new HttpError(400, 'Enter a valid hostname.');
  const evs = ctx.stream.events.filter((e) => e.source === 'edr' && e.host === h.name && e.fields.event_id === 1);
  const nodes = evs.map((e) => ({ id: e.id, ts: e.ts, pid: e.fields.pid, ppid: e.fields.ppid, user: e.fields.user, image: e.fields.image, command_line: e.fields.command_line, parent_image: e.fields.parent_image, children: [] }));
  const roots = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    let parent = null;
    for (let j = i - 1; j >= 0; j--) {
      if (nodes[j].pid === n.ppid && nodes[j].image === n.parent_image) { parent = nodes[j]; break; }
    }
    if (parent) parent.children.push(n);
    else {
      const k = `${n.parent_image}|${n.ppid}`;
      if (!roots.has(k)) roots.set(k, { synthetic: true, image: n.parent_image, pid: n.ppid, children: [] });
      roots.get(k).children.push(n);
    }
  }
  const f = String(filter || '').trim().toLowerCase();
  const hit = (n) => !f || `${n.image} ${n.command_line || ''}`.toLowerCase().includes(f);
  const keep = (n) => {
    if (hit(n) && !n.synthetic) return true; // keep the whole subtree below a match
    n.children = n.children.filter(keep);
    return n.children.length > 0;
  };
  const flat = [];
  const walk = (n, depth) => {
    flat.push({ depth, id: n.id, synthetic: !!n.synthetic, ts: n.ts, pid: n.pid, user: n.user, image: n.image, command_line: n.command_line });
    for (const ch of n.children) walk(ch, depth + 1);
  };
  for (const r of roots.values()) {
    if (f && !keep(r)) continue;
    walk(r, 0);
  }
  return { kind: 'proctree', host: h.name, filter: f, total: nodes.length, truncated: flat.length > 400, nodes: flat.slice(0, 400) };
}

function sandbox(ctx, input) {
  const h = norm.hash(input);
  if (!isHash(h)) throw new HttpError(400, 'Enter a full SHA-256 (64 hexadecimal characters).');
  const rep = ctx.scenario.sandbox && ctx.scenario.sandbox[h];
  if (rep) return { kind: 'sandbox', sha256: h, found: true, ...rep };
  if (KNOWN_GOOD_HASHES.has(h)) {
    const b = KNOWN_GOOD_HASHES.get(h);
    return { kind: 'sandbox', sha256: h, found: true, verdict: 'clean', score: 0, facts: [['File', b.path.split('\\').pop()], ['Signer', `${b.signer} (valid)`]], behaviours: ['No malicious behaviour. Known operating system or vendor binary.'], network: [], dropped: [] };
  }
  return { kind: 'sandbox', sha256: h, found: false, notes: ['No sample with this hash is available to detonate. The file was not captured by the mail gateway or EDR.'] };
}

const IMPL = { reputation, asset, user, change, decode, sweep, proctree, sandbox };

export function runTool(ctx, id, body) {
  const def = TOOLS.find((t) => t.id === id);
  if (!def) throw new HttpError(404, 'Unknown tool.');
  if (ctx.tier < def.tier) throw new HttpError(403, `${def.label} is available from Tier ${def.tier}.`);
  // The filter is bounded before the tool sees it and before it is recorded (like `input` below).
  const filter = String(body.filter || '').trim().slice(0, 300);
  const result = IMPL[id](ctx, body.input, filter);
  const input = String(body.input || '').trim().slice(0, 300);
  return { def, input, filter, result };
}

export const hostsList = HOSTS;
export { BENIGN_DOMAINS };
