/** Boot-time migration of the un-namespaced keys (security patch 2). Standalone build: namespace 'local'. */
import { beforeEach, describe, expect, it } from 'vitest';
import { initStorageNamespace, LEGACY_KEYS, nsKey } from './storage';

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

describe('initStorageNamespace migrates legacy keys at boot', () => {
  beforeEach(() => {
    const store = new MemoryStorage();
    // Object.keys(localStorage) is what migrateLegacyKey uses to detect other accounts' copies.
    Object.defineProperty(globalThis, 'localStorage', { value: new Proxy(store, { ownKeys: () => [...(store as unknown as { m: Map<string, string> }).m.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) }), configurable: true });
  });

  it('lists both legacy keys and claims them before any page reads storage', async () => {
    expect([...LEGACY_KEYS]).toEqual(['threatwall:lab-state', 'tw-last-route']);
    localStorage.setItem('tw-last-route', '/device/users');
    localStorage.setItem('threatwall:lab-state', '{"version":1}');
    const ns = await initStorageNamespace();
    expect(ns).toBe('local');
    expect(localStorage.getItem('tw-last-route')).toBeNull();
    expect(localStorage.getItem('threatwall:lab-state')).toBeNull();
    expect(localStorage.getItem(nsKey('tw-last-route'))).toBe('/device/users');
    expect(localStorage.getItem(nsKey('threatwall:lab-state'))).toBe('{"version":1}');
  });

  it('never overwrites an existing namespaced copy and drops a legacy key another account already claimed', async () => {
    localStorage.setItem('tw-last-route', '/old');
    localStorage.setItem(nsKey('tw-last-route'), '/mine');
    localStorage.setItem('threatwall:lab-state', 'old');
    localStorage.setItem('threatwall:someone-else:lab-state', 'theirs');
    await initStorageNamespace();
    expect(localStorage.getItem(nsKey('tw-last-route'))).toBe('/mine');
    expect(localStorage.getItem('tw-last-route')).toBeNull();
    expect(localStorage.getItem(nsKey('threatwall:lab-state'))).toBeNull();
    expect(localStorage.getItem('threatwall:lab-state')).toBeNull();
  });
});
