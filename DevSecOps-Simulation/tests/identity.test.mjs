// /labs/api/me lookup (platform.ts): what counts as signed out, when one retry happens, and that a hang ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { lookupPlatformUser, parseRetryAfter, waitText } = await import('../src/platform.ts');

const URL_ME = 'http://tr.test/labs/api/me';
const reply = (status, body = {}, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h) => headers[h] ?? headers[h.toLowerCase()] ?? null },
  json: async () => body,
});
/** fetch stub answering from a list; records each call. */
function fetchFrom(replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}
const noSleep = () => {
  const waits = [];
  const fn = async (ms) => void waits.push(ms);
  fn.waits = waits;
  return fn;
};

test('a confirmed user', async () => {
  const f = fetchFrom([reply(200, { id: 'user-1', name: ' Ada ' })]);
  const r = await lookupPlatformUser(URL_ME, { fetchImpl: f });
  assert.deepEqual(r, { user: { id: 'user-1', name: 'Ada' }, problem: null, retryAfter: null });
  assert.equal(f.calls[0].init.credentials, 'include');
  assert.equal(f.calls[0].init.cache, 'no-store');
});

test('401 and 403 mean signed out, without a retry', async () => {
  for (const status of [401, 403]) {
    const f = fetchFrom([reply(status)]);
    const r = await lookupPlatformUser(URL_ME, { fetchImpl: f, sleep: noSleep() });
    assert.equal(r.problem, 'signed-out');
    assert.equal(r.user, null);
    assert.equal(f.calls.length, 1);
  }
});

test('an answer without an id is not a user', async () => {
  const r = await lookupPlatformUser(URL_ME, { fetchImpl: fetchFrom([reply(200, { name: 'x' })]) });
  assert.equal(r.user, null);
  assert.equal(r.problem, 'signed-out');
});

test('429 with a short Retry-After is retried once, after that wait', async () => {
  const sleep = noSleep();
  const told = [];
  const f = fetchFrom([reply(429, {}, { 'Retry-After': '2' }), reply(200, { id: 'user-2' })]);
  const r = await lookupPlatformUser(URL_ME, { fetchImpl: f, sleep, onWait: (s) => told.push(s) });
  assert.equal(r.user?.id, 'user-2');
  assert.deepEqual(sleep.waits, [2000]);
  assert.deepEqual(told, [2]);
  assert.equal(f.calls.length, 2);
});

test('503 without Retry-After waits 1 s, and a second 503 gives up as unavailable', async () => {
  const sleep = noSleep();
  const f = fetchFrom([reply(503), reply(503, {}, { 'Retry-After': '5' })]);
  const r = await lookupPlatformUser(URL_ME, { fetchImpl: f, sleep });
  assert.deepEqual(sleep.waits, [1000]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(r, { user: null, problem: 'unavailable', retryAfter: 5 });
});

test('a long Retry-After is not sat out on the boot screen', async () => {
  const sleep = noSleep();
  const f = fetchFrom([reply(429, {}, { 'Retry-After': '40' })]);
  const r = await lookupPlatformUser(URL_ME, { fetchImpl: f, sleep });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(sleep.waits, []);
  assert.deepEqual(r, { user: null, problem: 'unavailable', retryAfter: 40 });
});

test('a network error or a 500 is unavailable', async () => {
  assert.equal((await lookupPlatformUser(URL_ME, { fetchImpl: fetchFrom([new TypeError('Failed to fetch')]) })).problem, 'unavailable');
  assert.equal((await lookupPlatformUser(URL_ME, { fetchImpl: fetchFrom([reply(500)]) })).problem, 'unavailable');
});

test('a request that never answers is aborted after the timeout', async () => {
  const hanging = (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  const t0 = Date.now();
  const r = await lookupPlatformUser(URL_ME, { fetchImpl: hanging, timeoutMs: 50 });
  assert.equal(r.problem, 'unavailable');
  assert.ok(Date.now() - t0 < 2000);
});

test('Retry-After as seconds or an HTTP date', () => {
  assert.equal(parseRetryAfter('7'), 7);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('soon'), null);
  const now = Date.parse('2026-10-23T10:00:00Z');
  assert.equal(parseRetryAfter('Fri, 23 Oct 2026 10:00:30 GMT', now), 30);
});

test('the wait is worded for people: 1 second, not "1 seconds"', () => {
  assert.equal(waitText(1), '1 second');
  assert.equal(waitText(0), '1 second');
  assert.equal(waitText(30), '30 seconds');
  assert.equal(waitText(89), '89 seconds');
  assert.equal(waitText(90), '2 minutes');
  assert.equal(waitText(600), '10 minutes');
});
