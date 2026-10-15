// Small SIEM-style query language.
//
//   powershell                    free-text term (matched against the raw line)
//   "net group"                   quoted phrase
//   dest_host:telemetry.*         field match, * is a wildcard
//   event_id:4624 logon_type:3    terms are ANDed
//   -user:MERIDIAN\svc_backup     leading - negates a term
//   bytes_out>100000              numeric comparison (>, >=, <, <=)
//   event_id:(4624|4625)          any of several values

function tokenize(q) {
  const out = [];
  let cur = '';
  let quote = false;
  let depth = 0;
  for (const ch of q) {
    if (ch === '"') { quote = !quote; cur += ch; continue; }
    if (!quote && ch === '(') depth++;
    if (!quote && ch === ')') depth = Math.max(0, depth - 1);
    if (!quote && depth === 0 && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const unquote = (s) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

function matcher(value) {
  const v = unquote(value).toLowerCase();
  if (v.includes('*')) {
    const re = new RegExp(`^${v.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return (x) => re.test(x);
  }
  return (x) => x === v;
}

export function parseQuery(q) {
  const terms = [];
  for (let tok of tokenize(String(q || '').trim())) {
    let neg = false;
    if (tok.startsWith('-') && tok.length > 1) { neg = true; tok = tok.slice(1); }
    const cmp = tok.match(/^([a-z_][a-z0-9_]*)(>=|<=|>|<)(-?\d+(?:\.\d+)?)$/i);
    if (cmp) {
      terms.push({ kind: 'cmp', field: cmp[1].toLowerCase(), op: cmp[2], num: Number(cmp[3]), neg });
      continue;
    }
    const fm = tok.match(/^([a-z_][a-z0-9_]*):(.+)$/i);
    if (fm && !/^[a-z]:\\/i.test(tok) && !/^https?:/i.test(tok)) {
      let val = fm[2];
      let alts;
      if (val.startsWith('(') && val.endsWith(')')) alts = val.slice(1, -1).split('|').map((s) => s.trim()).filter(Boolean);
      else alts = [val];
      terms.push({ kind: 'field', field: fm[1].toLowerCase(), tests: alts.map(matcher), neg });
      continue;
    }
    terms.push({ kind: 'text', text: unquote(tok).toLowerCase(), neg });
  }
  return terms;
}

// Level attempts match against the renamed view of each event (_lca/_fa),
// so analysts search with the names they can see.
function test(term, ev) {
  if (term.kind === 'text') return (ev._lca ?? ev._lc).includes(term.text);
  const raw = (ev._fa ?? ev.fields)[term.field];
  if (raw === undefined) return false;
  if (term.kind === 'cmp') {
    const n = Number(raw);
    if (Number.isNaN(n)) return false;
    return term.op === '>' ? n > term.num : term.op === '>=' ? n >= term.num : term.op === '<' ? n < term.num : n <= term.num;
  }
  const v = String(raw).toLowerCase();
  return term.tests.some((t) => t(v));
}

export function matches(terms, ev) {
  for (const t of terms) {
    if (test(t, ev) === t.neg) return false;
  }
  return true;
}
