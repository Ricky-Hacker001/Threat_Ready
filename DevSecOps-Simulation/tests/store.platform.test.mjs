// Progress storage inside ThreatReady (SEC-1 / BIZ-04 / TR-27): per account, tab-only when the account can't be
// confirmed, and a one-time, claim-safe migration of progress saved before keys were namespaced.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStorage, freshImport } from './helpers.mjs';

globalThis.__VITE_ENV__.BASE_URL = '/labs/devsecops/';
globalThis.window = { location: { origin: 'http://tr.test' } };

/** One page load of the lab: a new store module (module state is per page). */
const boot = () => freshImport(new URL('../src/store.ts', import.meta.url));
const result = (score) => ({ score, max: 130, mode: 'guided', minutes: 3, completedAt: 1 });
const unNamespaced = () => Object.keys(localStorage).filter((k) => k.startsWith('devsecops-lab:') && !k.startsWith('devsecops-lab:u:') && k !== 'devsecops-lab:legacy-migrated');

beforeEach(() => {
  globalThis.localStorage = new FakeStorage();
});

test('a confirmed user reads and writes only their own keys', async () => {
  const s = await boot();
  s.setStorageNamespace('user-a');
  s.saveProgress({ mode: 'guided', results: { 'red-build': result(90) } });
  assert.ok(localStorage.getItem('devsecops-lab:u:user-a:progress:v1'));
  assert.deepEqual(unNamespaced(), []);
});

test('without a confirmed user nothing is written to, or read from, localStorage', async () => {
  localStorage.setItem('devsecops-lab:progress:v1', JSON.stringify({ mode: 'expert', results: { 'red-build': result(77) } }));
  const s = await boot();
  s.setSessionOnlyStorage();
  assert.deepEqual(s.loadProgress(), { mode: null, results: {} }, 'the shared key is never read inside ThreatReady');
  s.saveProgress({ mode: 'guided', results: { lab3: result(55) } });
  s.saveLabState({ labId: 'lab3', pipelineRuns: [], notes: 'A' });
  assert.deepEqual(s.loadProgress().results.lab3.score, 55, 'progress lasts for this tab');
  assert.deepEqual(Object.keys(localStorage), ['devsecops-lab:progress:v1'], 'only the pre-existing key; nothing new');
});

test('before start-up decides, the store does not touch localStorage either', async () => {
  localStorage.setItem('devsecops-lab:progress:v1', JSON.stringify({ mode: 'expert', results: {} }));
  const s = await boot();
  assert.deepEqual(s.loadProgress(), { mode: null, results: {} });
  s.saveProgress({ mode: 'guided', results: {} });
  assert.deepEqual(Object.keys(localStorage), ['devsecops-lab:progress:v1']);
});

test('a /me failure, then a different user: that user starts with empty state', async () => {
  // A works with a confirmed lookup, then once while /me fails.
  let s = await boot();
  s.setStorageNamespace('user-a');
  s.migrateLegacyProgress();
  s.saveProgress({ mode: 'guided', results: { 'red-build': result(90) } });
  s = await boot();
  s.setSessionOnlyStorage();
  s.saveProgress({ mode: 'guided', results: { lab2: result(60) } });
  s.saveLabState({ labId: 'lab2', pipelineRuns: [], notes: 'A failed lookup' });
  // B opens the lab with a confirmed lookup.
  s = await boot();
  s.setStorageNamespace('user-b');
  s.migrateLegacyProgress();
  assert.deepEqual(s.loadProgress(), { mode: null, results: {} });
  assert.equal(s.loadLabState('lab2'), null);
  assert.deepEqual(unNamespaced(), []);
  // A's confirmed progress is untouched.
  s = await boot();
  s.setStorageNamespace('user-a');
  assert.equal(s.loadProgress().results['red-build'].score, 90);
});

test('pre-namespacing progress goes to the first confirmed user, once, with a marker', async () => {
  localStorage.setItem('devsecops-lab:progress:v1', JSON.stringify({ mode: 'standard', results: { 'red-build': result(80) } }));
  localStorage.setItem('devsecops-lab:state:v1:red-build', JSON.stringify({ labId: 'red-build', pipelineRuns: [] }));
  let s = await boot();
  s.setStorageNamespace('user-a');
  s.migrateLegacyProgress();
  assert.equal(s.loadProgress().results['red-build'].score, 80);
  assert.ok(s.loadLabState('red-build'));
  assert.deepEqual(unNamespaced(), []);
  assert.ok(localStorage.getItem('devsecops-lab:legacy-migrated'));
  // Shared keys that turn up later (an older build in another tab) are never handed to anyone.
  localStorage.setItem('devsecops-lab:progress:v1', JSON.stringify({ mode: 'expert', results: { stray: result(10) } }));
  s = await boot();
  s.setStorageNamespace('user-b');
  s.migrateLegacyProgress();
  assert.deepEqual(s.loadProgress(), { mode: null, results: {} });
  assert.deepEqual(unNamespaced(), []);
});

test('no migration when any account already has namespaced progress on this browser', async () => {
  localStorage.setItem('devsecops-lab:u:user-c:progress:v1', JSON.stringify({ mode: 'guided', results: {} }));
  localStorage.setItem('devsecops-lab:progress:v1', JSON.stringify({ mode: 'guided', results: { 'red-build': result(70) } }));
  const s = await boot();
  s.setStorageNamespace('user-a');
  s.migrateLegacyProgress();
  assert.deepEqual(s.loadProgress(), { mode: null, results: {} });
  assert.deepEqual(unNamespaced(), []);
  assert.ok(localStorage.getItem('devsecops-lab:u:user-c:progress:v1'), "another account's keys are left alone");
});

test('reset removes only this learner\'s keys', async () => {
  localStorage.setItem('devsecops-lab:u:user-c:progress:v1', '{}');
  const s = await boot();
  s.setStorageNamespace('user-a');
  s.saveProgress({ mode: 'guided', results: {} });
  s.saveLabState({ labId: 'red-build', pipelineRuns: [] });
  s.resetAll();
  assert.deepEqual(Object.keys(localStorage), ['devsecops-lab:u:user-c:progress:v1']);
});
