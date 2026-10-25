// Progress storage standalone (not served under /labs/): the original per-browser keys, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStorage } from './helpers.mjs';

globalThis.__VITE_ENV__.BASE_URL = '/';
globalThis.window = { location: { origin: 'http://localhost:5180' } };
globalThis.localStorage = new FakeStorage();
const s = await import('../src/store.ts');

test('standalone progress uses the un-namespaced keys in localStorage', () => {
  s.saveProgress({ mode: 'guided', results: {} });
  s.saveLabState({ labId: 'red-build', pipelineRuns: [] });
  assert.deepEqual(Object.keys(localStorage).sort(), ['devsecops-lab:progress:v1', 'devsecops-lab:state:v1:red-build']);
  assert.equal(s.loadProgress().mode, 'guided');
});

test('standalone reset clears the lab keys only', () => {
  localStorage.setItem('devsecops-ui:small-screen-notice', '1');
  s.resetAll();
  assert.deepEqual(Object.keys(localStorage), ['devsecops-ui:small-screen-notice']);
});
