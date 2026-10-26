#!/usr/bin/env node
/**
 * Keeps `Threatready-landing-page-main/apps/web/public/_headers` (Cloudflare static-asset headers, used when
 * the onboard SPA is hosted on its own) in sync with the security headers the production gateway sends
 * (`deploy/gateway.mjs`, which does not export them). The gateway is the source of truth: this script reads
 * its `res.setHeader(...)` calls from the source text — no import, no dependencies — and renders `_headers`.
 *
 *   node tools/gen-headers.mjs --check   # exit 1 (with a diff) when _headers differs from the gateway — CI
 *   node tools/gen-headers.mjs --write   # rewrite _headers from the gateway
 *   node tools/gen-headers.mjs           # print the generated file
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GATEWAY = path.join(REPO_ROOT, 'deploy', 'gateway.mjs');
export const HEADERS_FILE = path.join(REPO_ROOT, 'Threatready-landing-page-main', 'apps', 'web', 'public', '_headers');

/** The gateway's response headers that the static host must mirror, in the order they appear in `_headers`. */
const MIRRORED = ['Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy'];
/** Static-host-only headers the gateway does not send (kept verbatim). */
const EXTRA = ['Cross-Origin-Opener-Policy: same-origin-allow-popups'];

/** Pulls the CSP directive list and the other security headers out of gateway.mjs source text. */
export function extractGatewayHeaders(source) {
  // The gateway keeps its directives in `export const CSP_DIRECTIVES = [...]` (older layout: inline array
  // inside res.setHeader('Content-Security-Policy', [...].join('; '))); accept either.
  const csp = /export\s+const\s+CSP_DIRECTIVES\s*=\s*\[([\s\S]*?)\];/.exec(source)
    ?? /res\.setHeader\(\s*['"]Content-Security-Policy['"]\s*,\s*\[([\s\S]*?)\]\s*\.join\(\s*['"]; ['"]\s*\)\s*\)/.exec(source);
  if (!csp) throw new Error('gen-headers: cannot find the Content-Security-Policy array in deploy/gateway.mjs');
  const directives = [];
  const lit = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = lit.exec(csp[1]))) directives.push(m[2]);
  if (directives.length === 0) throw new Error('gen-headers: the CSP array is empty');
  const headers = { 'Content-Security-Policy': directives.join('; ') };
  for (const name of MIRRORED) {
    const re = new RegExp(`res\\.setHeader\\(\\s*['"]${name}['"]\\s*,\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1\\s*\\)`);
    const h = re.exec(source);
    if (!h) throw new Error(`gen-headers: cannot find res.setHeader('${name}', ...) in deploy/gateway.mjs`);
    headers[name] = h[2];
  }
  return headers;
}

export function render(headers) {
  const lines = [
    '# Cloudflare static assets: security headers for every SPA response (ADD L3).',
    '# GENERATED from deploy/gateway.mjs by tools/gen-headers.mjs — do not edit by hand; CI runs `--check`.',
    '/*',
    `  Content-Security-Policy: ${headers['Content-Security-Policy']}`,
    ...MIRRORED.map((n) => `  ${n}: ${headers[n]}`),
    ...EXTRA.map((l) => `  ${l}`),
    '',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ];
  return lines.join('\n');
}

export function generate(gatewayPath = GATEWAY) {
  return render(extractGatewayHeaders(fs.readFileSync(gatewayPath, 'utf8')));
}

function diff(expected, actual) {
  const a = expected.split('\n'), b = actual.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) { out.push(`line ${i + 1}:`); out.push(`  expected: ${a[i] ?? '<eof>'}`); out.push(`  actual:   ${b[i] ?? '<eof>'}`); }
  }
  return out.join('\n');
}

export function main(argv, { log = console.log, err = console.error } = {}) {
  const expected = generate();
  if (argv.includes('--write')) { fs.writeFileSync(HEADERS_FILE, expected); log(`gen-headers: wrote ${path.relative(REPO_ROOT, HEADERS_FILE)}`); return 0; }
  if (argv.includes('--check')) {
    const actual = fs.existsSync(HEADERS_FILE) ? fs.readFileSync(HEADERS_FILE, 'utf8') : '';
    if (actual === expected) { log(`gen-headers: ${path.relative(REPO_ROOT, HEADERS_FILE)} matches deploy/gateway.mjs`); return 0; }
    err(`gen-headers: ${path.relative(REPO_ROOT, HEADERS_FILE)} is out of date — run "node tools/gen-headers.mjs --write"\n${diff(expected, actual)}`);
    return 1;
  }
  log(expected);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
