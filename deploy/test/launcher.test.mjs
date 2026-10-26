// Launcher helpers (deploy/launcher-lib.mjs): per-caller token derivation, role-password sync decision,
// structured child-exit line, heap sampling and the labs child's client-IP trust. node:test, no deps.
import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { test } from 'node:test';
import { boolEnv, childExitLine, derivedToken, gatewayIpToForwardedFor, heapUsedOf, internalTokenEnv, passwordDigest, roleSyncNeeded } from '../launcher-lib.mjs';

const SECRET = 'k'.repeat(64);

test('derivedToken follows TOKEN_SPEC.md: HKDF-SHA256(secret, "threatready-internal", "caller->callee"), 32 bytes hex', () => {
  const expected = Buffer.from(hkdfSync('sha256', SECRET, 'threatready-internal', 'onboard->labs', 32)).toString('hex');
  assert.equal(derivedToken(SECRET, 'onboard', 'labs'), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.notEqual(derivedToken(SECRET, 'onboard', 'labs'), derivedToken(SECRET, 'labs', 'onboard'), 'direction matters');
  assert.notEqual(derivedToken(SECRET, 'onboard', 'labs'), derivedToken('j'.repeat(64), 'onboard', 'labs'), 'secret matters');
});

test('internalTokenEnv: every callee accepts exactly its callers, every caller presents the token minted for that callee', () => {
  const t = (a, b) => derivedToken(SECRET, a, b);
  const env = internalTokenEnv(SECRET);
  assert.deepEqual(env.onboard.INTERNAL_TOKENS_ACCEPT.split(','), [t('labs', 'onboard'), t('ar', 'onboard'), t('interview', 'onboard'), t('redteam', 'onboard')]);
  assert.equal(env.onboard.INTERNAL_TOKEN_TO_INTERVIEW, t('onboard', 'interview'));
  assert.equal(env.onboard.INTERNAL_TOKEN_TO_LABS, t('onboard', 'labs'));
  assert.equal(env.onboard.INTERNAL_TOKEN_TO_AR, t('onboard', 'ar'));
  assert.deepEqual(env.interview.INTERNAL_TOKENS_ACCEPT.split(','), [t('onboard', 'interview'), t('ar', 'interview')]);
  assert.equal(env.interview.INTERNAL_TOKEN_FROM_ONBOARD, t('onboard', 'interview'), 'InterviewPrep\'s onboard-only routes (erasure) take onboard\'s token alone (M-SEC-1)');
  assert.equal(env.interview.INTERNAL_TOKEN_TO_ONBOARD, t('interview', 'onboard'));
  // Labs child: union for the process, exact per app.
  assert.deepEqual(env.labs.INTERNAL_TOKENS_ACCEPT.split(','), [t('onboard', 'labs'), t('onboard', 'ar')]);
  assert.equal(env.labs.LABS_INTERNAL_TOKENS_ACCEPT, t('onboard', 'labs'));
  assert.equal(env.labs.AR_INTERNAL_TOKENS_ACCEPT, t('onboard', 'ar'));
  assert.equal(env.labs.LABS_INTERNAL_TOKEN_TO_ONBOARD, t('labs', 'onboard'));
  assert.equal(env.labs.AR_INTERNAL_TOKEN_TO_ONBOARD, t('ar', 'onboard'));
  assert.equal(env.labs.REDTEAM_INTERNAL_TOKEN_TO_ONBOARD, t('redteam', 'onboard'));
  assert.equal(env.labs.AR_INTERNAL_TOKEN_TO_INTERVIEW, t('ar', 'interview'));
  assert.equal(env.labs.INTERNAL_TOKEN_TO_INTERVIEW, t('ar', 'interview'));
  // What each caller presents is in the callee's accept list; the raw secret is in none.
  const onboardAccepts = env.onboard.INTERNAL_TOKENS_ACCEPT.split(',');
  for (const presented of [env.interview.INTERNAL_TOKEN_TO_ONBOARD, env.labs.LABS_INTERNAL_TOKEN_TO_ONBOARD, env.labs.AR_INTERNAL_TOKEN_TO_ONBOARD, env.labs.REDTEAM_INTERNAL_TOKEN_TO_ONBOARD]) assert.ok(onboardAccepts.includes(presented));
  assert.ok(env.interview.INTERNAL_TOKENS_ACCEPT.split(',').includes(env.onboard.INTERNAL_TOKEN_TO_INTERVIEW));
  assert.ok(env.interview.INTERNAL_TOKENS_ACCEPT.split(',').includes(env.labs.AR_INTERNAL_TOKEN_TO_INTERVIEW));
  // Onboard's token reaches InterviewPrep's erase/summary/ai-usage routes; nothing the labs child holds does (M-SEC-1).
  assert.equal(env.interview.INTERNAL_TOKEN_FROM_ONBOARD, env.onboard.INTERNAL_TOKEN_TO_INTERVIEW);
  assert.ok(!Object.values(env.labs).flatMap((v) => v.split(',')).includes(env.interview.INTERNAL_TOKEN_FROM_ONBOARD));
  assert.ok(env.labs.LABS_INTERNAL_TOKENS_ACCEPT === env.onboard.INTERNAL_TOKEN_TO_LABS);
  assert.ok(env.labs.AR_INTERNAL_TOKENS_ACCEPT === env.onboard.INTERNAL_TOKEN_TO_AR);
  const all = Object.values(env).flatMap((e) => Object.values(e).flatMap((v) => v.split(',')));
  assert.ok(!all.includes(SECRET), 'the raw INTERNAL_API_TOKEN is handed to no child');
  // A token that opens onboard opens nothing else.
  assert.ok(!env.interview.INTERNAL_TOKENS_ACCEPT.split(',').some((x) => onboardAccepts.includes(x)));
});

test('roleSyncNeeded: ALTER ROLE only when the role is new, the digest differs, or FORCE_ROLE_SYNC', () => {
  const password = 'p'.repeat(48);
  const stored = passwordDigest(password);
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.equal(roleSyncNeeded({ roleExists: true, stored, password }), false, 'unchanged → skip');
  assert.equal(roleSyncNeeded({ roleExists: true, stored, password: 'q'.repeat(48) }), true, 'rotated → alter');
  assert.equal(roleSyncNeeded({ roleExists: true, stored: null, password }), true, 'no digest yet → alter once');
  assert.equal(roleSyncNeeded({ roleExists: false, stored, password }), true, 'no role → create');
  assert.equal(roleSyncNeeded({ roleExists: true, stored, password, force: true }), true, 'FORCE_ROLE_SYNC');
});

test('childExitLine is one JSON object with the documented fields', () => {
  const line = JSON.parse(childExitLine({ name: 'labs', code: 1, signal: null, startedAt: 1_000, exits: 3, now: 61_000 }));
  assert.deepEqual(line, { event: 'child_exit', name: 'labs', code: 1, signal: null, uptimeMs: 60_000, exits: 3 });
  const killed = JSON.parse(childExitLine({ name: 'onboard', code: null, signal: 'SIGKILL', startedAt: 5, exits: 1, now: 4 }));
  assert.equal(killed.signal, 'SIGKILL'); assert.equal(killed.code, null); assert.equal(killed.uptimeMs, 0);
});

test('heapUsedOf reads a finite heapUsed and nothing else', () => {
  assert.equal(heapUsedOf({ heapUsed: 12345 }), 12345);
  assert.equal(heapUsedOf({ heapUsed: -1 }), null);
  assert.equal(heapUsedOf({ heapUsed: 'x' }), null);
  assert.equal(heapUsedOf({ message: 'Cannot GET /' }), null);
  assert.equal(heapUsedOf(null), null);
});

test('gatewayIpToForwardedFor: the gateway stamp becomes X-Forwarded-For for a loopback peer, nothing otherwise', () => {
  const mw = gatewayIpToForwardedFor('x-threatready-client-ip');
  const run = (remoteAddress, headers) => { const req = { socket: { remoteAddress }, headers: { ...headers } }; let called = false; mw(req, {}, () => { called = true; }); assert.ok(called); return req.headers; };
  assert.equal(run('127.0.0.1', { 'x-threatready-client-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' })['x-forwarded-for'], '203.0.113.9');
  assert.equal(run('::1', { 'x-threatready-client-ip': '2001:db8::1' })['x-forwarded-for'], '2001:db8::1');
  const junk = run('127.0.0.1', { 'x-threatready-client-ip': 'nope', 'x-forwarded-for': '1.2.3.4' });
  assert.equal(junk['x-forwarded-for'], undefined); assert.equal(junk['x-threatready-client-ip'], undefined);
  const remote = run('10.0.0.5', { 'x-threatready-client-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' });
  assert.equal(remote['x-forwarded-for'], undefined); assert.equal(remote['x-threatready-client-ip'], undefined);
});

test('boolEnv', () => {
  assert.equal(boolEnv(undefined, true), true); assert.equal(boolEnv('', false), false);
  assert.equal(boolEnv('true', false), true); assert.equal(boolEnv('1', false), true); assert.equal(boolEnv('false', true), false); assert.equal(boolEnv('no', true), false);
});
