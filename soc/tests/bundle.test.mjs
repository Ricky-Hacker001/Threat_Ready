// The built client must not carry answer keys, scenario stories, secrets or
// any certificate feature (Build specification, sections 2.1 and 12).
// Runs against client/dist; build first with `npm run build`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SOC_SIM_TEST = '1';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'client', 'dist');
const { allLevelScenarios } = await import('../server/scenarios/index.js');

function bundleText() {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(js|css|html)$/.test(f)) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(dist);
  return out.join('\n');
}

const built = fs.existsSync(path.join(dist, 'index.html'));

test('built client carries no scenario story, explanation or answer key', { skip: !built && 'client not built' }, () => {
  const text = bundleText();
  const leaks = [];
  for (const s of allLevelScenarios()) {
    const truth = s.secret.truth({ t0: Date.now() });
    const probe = truth.summary.slice(0, 60);
    if (text.includes(probe)) leaks.push(`${s.code} truth`);
    for (const st of s.stages) {
      for (const f of st.fields || []) {
        const ex = f.key?.explain;
        if (ex && ex.length > 30 && text.includes(ex)) leaks.push(`${s.code} ${st.id}.${f.id} explanation`);
        const hint = f.key?.hint;
        if (hint && hint.length > 30 && text.includes(hint)) leaks.push(`${s.code} ${st.id}.${f.id} hint`);
      }
    }
    for (const o of s.secret.response.objectives || []) if (o.explain && o.explain.length > 30 && text.includes(o.explain)) leaks.push(`${s.code} objective ${o.id}`);
  }
  assert.deepEqual(leaks, []);
});

test('built client carries no secrets or server-only configuration', { skip: !built && 'client not built' }, () => {
  const text = bundleText();
  for (const k of ['TR_SIM_SECRET', 'SIM_SESSION_SECRET', 'TR_WEBHOOK_SECRET', 'TR_EXPORT_TOKEN', 'dev-only-session-secret']) assert.ok(!text.includes(k), k);
});

test('built client has no certificate feature, only "not a certification" disclaimers', { skip: !built && 'client not built' }, () => {
  const text = bundleText();
  const hits = [...text.matchAll(/.{0,40}certific.{0,20}/gi)].map((m) => m[0]);
  const bad = hits.filter((h) => !/not (a|an assessment or a) certification/i.test(h));
  assert.deepEqual(bad, []);
  assert.ok(!/download certificate|certificate id|verify certificate|\/api\/verify/i.test(text));
});

// Inside ThreatReady the client is served under /labs/soc/: an absolute "/api/..." in a link, a download
// or the live stream would reach the platform's own /api instead (TR-12). Such URLs go through apiUrl().
const ABSOLUTE_API = [
  [/new EventSource\(\s*[`'"]\/api/, 'EventSource on an absolute /api path'],
  [/\bhref\s*[:=]\s*\{?\s*[`'"]\/api/, 'link to an absolute /api path'],
  [/location(?:\.href)?\s*=\s*[`'"]\/api/, 'navigation to an absolute /api path'],
  [/window\.open\(\s*[`'"]\/api/, 'window.open on an absolute /api path'],
];
function sources(dir, re) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) out.push(...sources(p, re));
    else if (re.test(f)) out.push([path.relative(root, p), fs.readFileSync(p, 'utf8')]);
  }
  return out;
}

test('client source builds stream, link and download URLs under the base path', () => {
  const bad = [];
  for (const [file, text] of sources(path.join(root, 'client', 'src'), /\.(jsx?|tsx?)$/)) for (const [re, what] of ABSOLUTE_API) if (re.test(text)) bad.push(`${file}: ${what}`);
  assert.deepEqual(bad, []);
});

test('built client has no absolute /api stream, link or download', { skip: !built && 'client not built' }, () => {
  const text = bundleText();
  assert.deepEqual(ABSOLUTE_API.filter(([re]) => re.test(text)).map(([, what]) => what), []);
  assert.match(text, /\/api\/cases\/\$\{[^}]+\}\/stream/, 'the stream path is in the bundle');
});
