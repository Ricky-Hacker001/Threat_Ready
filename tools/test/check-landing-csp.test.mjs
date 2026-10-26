// node --test "tools/test/*.test.mjs" — the static landing pages keep a hash-based CSP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHtml, hashOf, run } from '../check-landing-csp.mjs';

const page = (csp, body) => `<!DOCTYPE html><html><head><meta charset="UTF-8">${csp ? `<meta http-equiv="Content-Security-Policy" content="${csp}">` : ''}${body}</head><body></body></html>`;
const inline = "try{document.documentElement.setAttribute('data-theme','light')}catch(e){}";
const BASE = "default-src 'self'; script-src 'self' HASH; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'";

test('a page whose inline script hash is in script-src passes', () => {
  assert.deepEqual(checkHtml(page(BASE.replace('HASH', hashOf(inline)), `<script>${inline}</script><script src="assets/js/site.js" defer></script>`)), []);
});

test('a missing meta, a stale hash, unsafe-inline and a script placed before the meta are reported', () => {
  assert.deepEqual(checkHtml(page('', `<script>${inline}</script>`)), ['no <meta http-equiv="Content-Security-Policy">']);
  const stale = checkHtml(page(BASE.replace('HASH', hashOf('other')), `<script>${inline}</script>`));
  assert.equal(stale.length, 1); assert.match(stale[0], /needs 'sha256-/);
  assert.ok(checkHtml(page(BASE.replace('HASH', "'unsafe-inline'"), `<script>${inline}</script>`)).some((p) => /unsafe-inline/.test(p)));
  const early = checkHtml(`<!DOCTYPE html><html><head><script>${inline}</script><meta http-equiv="Content-Security-Policy" content="${BASE.replace('HASH', hashOf(inline))}"></head></html>`);
  assert.ok(early.some((p) => /before the CSP meta/.test(p)));
});

test('every page in Landing_Page-main passes', () => {
  const errs = [];
  assert.equal(run([], { log: () => {}, err: (s) => errs.push(s) }), 0, errs.join('\n'));
});
