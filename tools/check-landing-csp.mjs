#!/usr/bin/env node
/**
 * Landing page (Landing_Page-main, static HTML) CSP check — dependency-free.
 * Every page must carry a `<meta http-equiv="Content-Security-Policy">` placed before its first <script>, and
 * every inline <script> must be covered by a `'sha256-…'` hash in `script-src` (no 'unsafe-inline'), so an edit
 * to an inline script that forgets the hash fails CI instead of breaking the page's theme switch or TOC.
 *
 *   node tools/check-landing-csp.mjs                 # all Landing_Page-main/*.html
 *   node tools/check-landing-csp.mjs path/a.html …   # specific files
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LANDING_DIR = path.join(REPO_ROOT, 'Landing_Page-main');

const META_RE = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(?:"([^"]*)"|'([^']*)')\s*\/?>/i;
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

export const hashOf = (text) => "'sha256-" + crypto.createHash('sha256').update(text, 'utf8').digest('base64') + "'";

/** Returns the list of problems for one HTML document (empty when it passes). */
export function checkHtml(html) {
  const problems = [];
  const meta = META_RE.exec(html);
  if (!meta) return ['no <meta http-equiv="Content-Security-Policy">'];
  const directives = Object.fromEntries((meta[1] ?? meta[2] ?? '').split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...rest] = d.split(/\s+/); return [name.toLowerCase(), rest]; }));
  const scriptSrc = directives['script-src'] ?? directives['default-src'];
  if (!scriptSrc) problems.push('CSP has neither script-src nor default-src');
  if (scriptSrc?.includes("'unsafe-inline'")) problems.push("script-src allows 'unsafe-inline'");
  if (scriptSrc?.includes("'unsafe-eval'")) problems.push("script-src allows 'unsafe-eval'");
  if (!directives['object-src'] || !directives['object-src'].includes("'none'")) problems.push("missing object-src 'none'");
  if (!directives['base-uri']) problems.push('missing base-uri');
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html))) {
    const attrs = m[1];
    if (m.index < meta.index) problems.push(`<script> at offset ${m.index} comes before the CSP meta and is not governed by it`);
    if (/\bsrc\s*=/i.test(attrs)) {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? '';
      if (/^(https?:)?\/\//i.test(src) && !scriptSrc?.some((s) => s !== "'self'" && src.startsWith(s))) problems.push(`external script ${src} not allowed by script-src`);
      continue;
    }
    if (/\btype\s*=\s*["'](?!text\/javascript|module)["']?[^"']*["']/i.test(attrs) && !/text\/javascript|module/i.test(attrs)) continue; // data blocks (application/ld+json etc.) do not execute
    const h = hashOf(m[2]);
    if (!scriptSrc?.includes(h)) problems.push(`inline script (${m[2].trim().slice(0, 50).replace(/\s+/g, ' ')}…) needs ${h} in script-src`);
  }
  const handlers = html.match(/\s(?:onclick|onload|onerror|onsubmit|onchange|oninput|onkeydown|onkeyup|onmouseover|onfocus|onblur)\s*=/gi);
  if (handlers) problems.push(`${handlers.length} inline event handler attribute(s) would be blocked by this CSP`);
  if (/\bhref\s*=\s*["']javascript:/i.test(html)) problems.push('javascript: URL would be blocked by this CSP');
  return problems;
}

export function run(files, { log = console.log, err = console.error } = {}) {
  const list = files.length ? files : fs.readdirSync(LANDING_DIR).filter((f) => f.endsWith('.html')).sort().map((f) => path.join(LANDING_DIR, f));
  let failed = 0;
  for (const f of list) {
    const problems = checkHtml(fs.readFileSync(f, 'utf8'));
    const rel = path.relative(REPO_ROOT, f).split(path.sep).join('/');
    if (problems.length) { failed++; for (const p of problems) err(`${rel}: ${p}`); } else log(`${rel}: ok`);
  }
  log(`check-landing-csp: ${list.length} page(s), ${failed} failing`);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = run(process.argv.slice(2).map((p) => path.resolve(p)));
