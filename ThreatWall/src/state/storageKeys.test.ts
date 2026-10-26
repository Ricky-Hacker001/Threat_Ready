// BIZ-05: the Playwright walkthrough (e2e/lib.mjs) reads and seeds the standalone lab-state key; keep the two in step.
// Raw source via Vite's ?raw (typed by vite/client), so the test needs no Node type definitions.
import harness from '../../e2e/lib.mjs?raw';
import { describe, expect, it } from 'vitest';
import { LEGACY_STORAGE_KEYS, labStateKey, lastRouteKey } from './storageKeys';

describe('storage keys', () => {
  it('standalone keys are the original, un-namespaced ones', () => {
    expect(labStateKey()).toBe('threatwall:lab-state');
    expect(lastRouteKey()).toBe('tw-last-route');
    expect(LEGACY_STORAGE_KEYS).toEqual(['threatwall:lab-state', 'tw-last-route']);
  });
  it('the e2e harness uses the same lab-state key (and not a removed scheme)', () => {
    expect(harness).toContain(`'${labStateKey()}'`);
    expect(harness).not.toContain('threatwall:local');
    expect(harness.match(/localStorage\.(get|set)Item\('/g) ?? []).toEqual([]);
  });
});
