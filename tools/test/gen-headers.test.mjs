// node --test "tools/test/*.test.mjs" — the generated _headers must mirror deploy/gateway.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractGatewayHeaders, render, generate, main, HEADERS_FILE, GATEWAY } from '../gen-headers.mjs';

const SNIPPET = `
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      'frame-src https://challenges.cloudflare.com',
      "object-src 'none'",
    ].join('; '));
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=()');
    res.setHeader('X-Robots-Tag', 'noindex');
    next();
  });`;

test('extracts every directive (both quote styles) and the five mirrored headers', () => {
  const h = extractGatewayHeaders(SNIPPET);
  assert.equal(h['Content-Security-Policy'], "default-src 'self'; frame-src https://challenges.cloudflare.com; object-src 'none'");
  assert.equal(h['Permissions-Policy'], 'camera=(), geolocation=()');
  assert.equal(h['X-Robots-Tag'], 'noindex');
  assert.match(render(h), /^\/\*\n  Content-Security-Policy: default-src 'self'; frame-src/m);
  assert.match(render(h), /\n\/assets\/\*\n  Cache-Control: public, max-age=31536000, immutable\n$/);
});

test('refuses a gateway without a CSP array', () => {
  assert.throws(() => extractGatewayHeaders("res.setHeader('X-Frame-Options', 'DENY')"), /cannot find the Content-Security-Policy/);
});

test('the real gateway CSP is what _headers ships, and --check reports drift', () => {
  const gateway = fs.readFileSync(GATEWAY, 'utf8');
  const csp = extractGatewayHeaders(gateway)['Content-Security-Policy'];
  assert.match(csp, /frame-ancestors 'none'/);
  const onDisk = fs.readFileSync(HEADERS_FILE, 'utf8');
  assert.equal(onDisk, generate(), 'run: node tools/gen-headers.mjs --write');
  assert.ok(onDisk.includes(`Content-Security-Policy: ${csp}\n`));
  const errs = [];
  assert.equal(main(['--check'], { log: () => {}, err: (s) => errs.push(s) }), 0);
});
