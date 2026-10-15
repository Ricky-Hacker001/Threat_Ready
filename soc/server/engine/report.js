// After-action report. Built once, at closure. This is the only place the
// scenario's answer key and ground-truth narrative are serialised.

import { describeValue, describeExpected, verdictOf } from './grading.js';

function band(score) {
  if (score >= 90) return 'Exemplary';
  if (score >= 75) return 'Proficient';
  if (score >= 55) return 'Developing';
  return 'Needs coaching';
}

export function buildReport(c, scn, stream, total) {
  const stages = [];
  for (const def of scn.stages) {
    const st = c.stages[def.id];
    if (!def.weight) continue;
    if (st.status === 'skipped') {
      stages.push({ id: def.id, label: def.label, tier: def.tier, skipped: true, weight: def.weight });
      continue;
    }
    if (st.status !== 'done') continue;
    const row = {
      id: def.id, label: def.label, tier: def.tier, weight: def.weight,
      earned: st.score.earned, max: st.score.max,
      pct: st.score.max ? Math.round((st.score.earned / st.score.max) * 100) : 0,
      attempts: st.attempts, seconds: st.startedAt && st.completedAt ? Math.round((st.completedAt - st.startedAt) / 1000) : null,
    };
    if (def.kind === 'form') {
      row.fields = def.fields.map((f) => {
        const fs = st.fields[f.id];
        return {
          label: f.label,
          yours: f.type === 'longtext' ? String(fs.value || '').trim() : f.type === 'checks' ? f.key.checks.filter((ch) => ch.test(c, stream)).map((ch) => ch.label).join('; ') || 'None performed' : describeValue(f, fs.value),
          expected: describeExpected(f),
          verdict: verdictOf(fs.credit),
          supported: f.linkable ? !!fs.supported : undefined,
          earned: fs.earned ?? 0,
          points: f.points || 0,
          explain: f.key?.explain,
        };
      });
    }
    if (def.kind === 'response') {
      row.objectives = st.evaluation.objectives.map((o) => ({ label: o.label, earned: o.earned, points: o.points, verdict: verdictOf(o.credit), explain: o.explain, note: o.note }));
      row.findings = st.evaluation.findings;
      row.penalty = st.evaluation.penalty;
    }
    stages.push(row);
  }

  const truth = scn.secret.truth({ t0: c.t0 });
  return {
    score: total,
    band: band(total ?? 0),
    generatedAt: c.closedAt,
    stages,
    truth,
  };
}

const fmt = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
const dur = (s) => (s == null ? '-' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

// Markdown export of the whole case file.
export function exportMarkdown(pub) {
  const L = [];
  L.push(`# ${pub.ticket} - ${pub.title}`, '');
  L.push(`- Scenario: ${pub.scenarioTitle}`, `- Analyst: ${pub.analyst}`, `- Status: ${pub.status}`, `- Severity: ${pub.severity || '-'}`, `- Opened: ${fmt(pub.createdAt)}`);
  if (pub.closedAt) L.push(`- Closed: ${fmt(pub.closedAt)}`);
  if (pub.report) L.push(`- Score: ${pub.report.score}/100 (${pub.report.band})`);
  L.push('');
  if (pub.metrics?.length) {
    L.push('## Metrics', '');
    for (const m of pub.metrics) L.push(`- ${m.label}: ${dur(m.seconds)}`);
    L.push('');
  }
  if (pub.alert) {
    L.push('## Alert', '', `**${pub.alert.rule}** ${pub.alert.title} (${pub.alert.severity})`, '', pub.alert.description, '');
  }
  if (pub.iocs.length) {
    L.push('## Indicators', '');
    for (const i of pub.iocs) L.push(`- ${i.type}: \`${i.value}\``);
    L.push('');
  }
  if (pub.pins.length) {
    L.push('## Pinned evidence', '');
    for (const p of pub.pins) L.push(`- \`${p.event.raw}\`${p.note ? `\n  - Note: ${p.note}` : ''}`);
    L.push('');
  }
  if (pub.report) {
    const r = pub.report;
    L.push('## After-action review', '');
    for (const s of r.stages) {
      if (s.skipped) { L.push(`### ${s.label} - not required`, ''); continue; }
      L.push(`### ${s.label} - ${s.pct}% (${s.earned}/${s.max})`, '');
      for (const f of s.fields || []) {
        L.push(`- **${f.label}** - ${f.verdict}${f.supported === false ? ' (not corroborated by linked evidence)' : ''} (${f.earned}/${f.points})`, `  - Your answer: ${f.yours}`, `  - Expected: ${f.expected}`);
        if (f.explain) L.push(`  - Why: ${f.explain}`);
      }
      for (const o of s.objectives || []) {
        L.push(`- **${o.label}** - ${o.verdict} (${o.earned}/${o.points})`);
        if (o.explain) L.push(`  - Why: ${o.explain}`);
      }
      for (const f of s.findings || []) L.push(`- Deduction -${f.points}: ${f.action}. ${f.reason}`);
      L.push('');
    }
    L.push('## What actually happened', '', r.truth.summary, '');
    for (const t of r.truth.timeline) L.push(`- ${fmt(t.ts)} - ${t.text}`);
    L.push('');
    if (r.truth.iocs?.length) {
      L.push('### Indicators of compromise', '');
      for (const i of r.truth.iocs) L.push(`- ${i.type}: \`${i.value}\` - ${i.note}`);
      L.push('');
    }
  }
  L.push('## Case history', '');
  for (const h of pub.history) L.push(`- ${fmt(h.ts)} - **${h.actor}** - ${h.text}`);
  L.push('');
  return L.join('\n');
}
