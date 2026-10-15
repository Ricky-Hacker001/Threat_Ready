// Field grading. A stage definition's fields each carry a private `key`
// object (accepted answers, supporting-evidence tags, hints, explanation).
// `key` never leaves the server until the case is closed.

export const norm = {
  lower: (s) => String(s ?? '').trim().toLowerCase(),
  domain: (s) => String(s ?? '').trim().toLowerCase()
    .replace(/\[\.\]|\(\.\)|\[dot\]/g, '.').replace(/^hxxp/, 'http')
    .replace(/^[a-z]+:\/\//, '').split('/')[0].split(':')[0].replace(/\.$/, ''),
  ip: (s) => String(s ?? '').trim().replace(/\[\.\]/g, '.').split(':')[0],
  hash: (s) => String(s ?? '').trim().toLowerCase().replace(/^sha-?256[:=]\s*/, ''),
  process: (s) => String(s ?? '').trim().toLowerCase().split(/[\\/]/).pop(),
};

const SET_TYPES = new Set(['multi', 'hosts', 'accounts']);
const ONE_TYPES = new Set(['single', 'host', 'account']);

export function isEmpty(field, v) {
  if (field.type === 'checks') return false;
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === '';
}

// Returns a validation message, or null when the value can be graded.
export function validateField(field, v) {
  if (field.type === 'checks') return null;
  if (isEmpty(field, v)) return field.required === false ? null : `${field.label}: required.`;
  if (field.type === 'longtext' && field.min && String(v).trim().length < field.min) return `${field.label}: write at least ${field.min} characters.`;
  if (field.type === 'pins' && field.min && v.length < field.min) return `${field.label}: select at least ${field.min} pinned events.`;
  if (field.type === 'order' && (!Array.isArray(v) || v.length !== field.items.length)) return `${field.label}: order every item.`;
  return null;
}

export function gradeField(field, value, ctx) {
  const key = field.key || {};
  const t = field.type;

  if (ONE_TYPES.has(t)) {
    const v = norm.lower(value);
    if (typeof key.accept === 'string') return { credit: v === key.accept.toLowerCase() ? 1 : 0 };
    const map = Object.fromEntries(Object.entries(key.accept || {}).map(([k, c]) => [k.toLowerCase(), c]));
    return { credit: map[v] ?? 0 };
  }

  if (SET_TYPES.has(t)) {
    const want = new Set((key.set || []).map(norm.lower));
    const neutral = new Set((key.neutral || []).map(norm.lower));
    const got = [...new Set((value || []).map(norm.lower))];
    const tp = got.filter((x) => want.has(x)).length;
    const fp = got.filter((x) => !want.has(x) && !neutral.has(x)).length;
    const credit = want.size ? Math.max(0, (tp - fp) / want.size) : fp ? 0 : 1;
    const parts = [];
    if (fp) parts.push(`${fp} selection${fp === 1 ? ' is' : 's are'} not supported by the evidence`);
    if (tp < want.size) parts.push(`${want.size - tp} expected item${want.size - tp === 1 ? ' is' : 's are'} missing`);
    return { credit, detail: parts.length ? `${parts.join('; ')}.` : undefined };
  }

  if (t === 'text') {
    const n = norm[key.norm || 'lower'];
    const v = n(value);
    return { credit: (key.accept || []).some((a) => n(a) === v) ? 1 : 0 };
  }

  if (t === 'longtext') {
    return { credit: String(value || '').trim().length >= (field.min || 1) ? 1 : 0 };
  }

  if (t === 'order') {
    const want = key.order;
    const pos = new Map((value || []).map((id, i) => [id, i]));
    let ok = 0;
    let total = 0;
    for (let i = 0; i < want.length; i++) {
      for (let j = i + 1; j < want.length; j++) {
        total++;
        if (pos.has(want[i]) && pos.has(want[j]) && pos.get(want[i]) < pos.get(want[j])) ok++;
      }
    }
    const credit = total ? ok / total : 0;
    return { credit, detail: credit < 1 ? `${total - ok} of ${total} pairwise orderings are wrong.` : undefined };
  }

  if (t === 'pins') {
    const ids = [...new Set(value || [])];
    const groups = key.groups || {};
    const covered = new Set();
    let relevant = 0;
    for (const id of ids) {
      const tags = ctx.stream.get(id)?._tags || [];
      let rel = false;
      for (const [g, gtags] of Object.entries(groups)) {
        if (tags.some((x) => gtags.includes(x))) { covered.add(g); rel = true; }
      }
      if (rel) relevant++;
    }
    const need = key.minGroups || 1;
    const coverage = Math.min(1, covered.size / need);
    const precision = ids.length ? relevant / ids.length : 0;
    const credit = coverage * Math.min(1, precision / (key.minPrecision || 0.6));
    const parts = [];
    if (covered.size < need) parts.push(`the selected events cover ${covered.size} of the ${need} distinct kinds of evidence this decision should rest on`);
    if (relevant < ids.length) parts.push(`${ids.length - relevant} selected event${ids.length - relevant === 1 ? ' is' : 's are'} unrelated to the activity`);
    return { credit, detail: parts.length ? `${parts.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()) : undefined };
  }

  if (t === 'ioc_list') {
    const n = (x) => (/^[a-f0-9]{64}$/i.test(String(x.value).trim()) ? norm.hash(x.value) : norm.domain(x.value));
    const got = [...new Set((value || []).map(n).filter(Boolean))];
    const must = (key.must || []).map(norm.lower);
    const valid = new Set((key.valid || []).map(norm.lower));
    const hasMust = must.filter((m) => got.includes(m)).length;
    const extra = got.filter((g) => valid.has(g) && !must.includes(g)).length;
    const bad = got.filter((g) => !valid.has(g)).length;
    const wantExtra = key.wantExtra ?? 2;
    let credit = (must.length ? 0.6 * (hasMust / must.length) : 0.6) + 0.4 * Math.min(1, wantExtra ? extra / wantExtra : 1) - 0.2 * bad;
    credit = Math.max(0, Math.min(1, credit));
    const parts = [];
    if (hasMust < must.length) parts.push('the indicator that defines this alert is missing');
    if (extra < wantExtra) parts.push(`add at least ${wantExtra - extra} more indicator${wantExtra - extra === 1 ? '' : 's'} supported by the evidence`);
    if (bad) parts.push(`${bad} entr${bad === 1 ? 'y is' : 'ies are'} not attacker indicators`);
    return { credit, detail: parts.length ? `${parts.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()) : undefined };
  }

  if (t === 'pin_one') {
    const tags = ctx.stream.get(value)?._tags || [];
    let credit = 0;
    for (const [tag, c] of Object.entries(key.accept || {})) if (tags.includes(tag)) credit = Math.max(credit, c);
    return { credit, detail: credit > 0 && credit < 1 ? (key.partialDetail || 'That event is part of the activity, but an earlier one exists.') : undefined };
  }

  if (t === 'checks') {
    const checks = key.checks || [];
    const done = checks.filter((ch) => ch.test(ctx.case, ctx.stream)).length;
    return { credit: checks.length ? done / checks.length : 1, detail: done < checks.length ? `${checks.length - done} check${checks.length - done === 1 ? ' was' : 's were'} not performed.` : undefined };
  }

  return { credit: 0 };
}

export const verdictOf = (credit) => (credit >= 0.999 ? 'correct' : credit > 0 ? 'partial' : 'incorrect');

// Human-readable rendering of answers for the after-action report.
export function describeValue(field, value, dir) {
  const opt = (v) => field.options?.find((o) => String(o.value).toLowerCase() === String(v).toLowerCase())?.label ?? String(v);
  const t = field.type;
  if (value === undefined || value === null || (Array.isArray(value) && !value.length) || value === '') return '-';
  if (t === 'single') return opt(value);
  if (t === 'multi') return value.map(opt).join('; ');
  if (t === 'hosts' || t === 'accounts') return value.join(', ');
  if (t === 'order') return value.map((id, i) => `${i + 1}. ${field.items.find((x) => x.id === id)?.label ?? id}`).join('  ');
  if (t === 'pins') return `${value.length} pinned event${value.length === 1 ? '' : 's'}`;
  if (t === 'pin_one') return 'One pinned event';
  if (t === 'ioc_list') return value.map((x) => x.value).join(', ');
  return String(value);
}

export function describeExpected(field) {
  const key = field.key || {};
  const opt = (v) => field.options?.find((o) => String(o.value).toLowerCase() === String(v).toLowerCase())?.label ?? String(v);
  const t = field.type;
  if (ONE_TYPES.has(t)) {
    if (typeof key.accept === 'string') return opt(key.accept);
    const full = Object.entries(key.accept || {}).filter(([, c]) => c >= 1).map(([v]) => opt(v));
    const part = Object.entries(key.accept || {}).filter(([, c]) => c > 0 && c < 1).map(([v]) => opt(v));
    return full.join(' or ') + (part.length ? ` (partial credit: ${part.join(', ')})` : '');
  }
  if (t === 'multi') return (key.set || []).map(opt).join('; ');
  if (SET_TYPES.has(t)) return (key.set || []).join(', ');
  if (t === 'text') return key.accept?.[0] ?? '';
  if (t === 'order') return key.order.map((id, i) => `${i + 1}. ${field.items.find((x) => x.id === id)?.label ?? id}`).join('  ');
  if (t === 'pins' || t === 'pin_one') return key.describe || 'Events that directly show the activity.';
  if (t === 'ioc_list') return `${(key.must || []).join(', ')}${key.valid ? ` plus further indicators such as ${(key.valid || []).filter((v) => !(key.must || []).includes(v)).slice(0, 4).join(', ')}` : ''}`;
  if (t === 'checks') return (key.checks || []).map((c) => c.label).join('; ');
  if (t === 'longtext') return 'Free-text entry (recorded in the case file, not auto-graded for content).';
  return '';
}
