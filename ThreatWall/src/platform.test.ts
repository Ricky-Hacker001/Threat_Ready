// Inside ThreatReady (SEC-1 / BIZ-04 / TR-27): progress per account, tab-only when the account can't be confirmed
// (never the shared key), one short retry when ThreatReady is busy, and a one-time claim-safe legacy migration.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeStorage {
  getItem(k: string): string | null { return Object.prototype.hasOwnProperty.call(this, k) ? (this as unknown as Record<string, string>)[k] : null; }
  setItem(k: string, v: string): void { (this as unknown as Record<string, string>)[k] = String(v); }
  removeItem(k: string): void { delete (this as unknown as Record<string, string>)[k]; }
}

type Platform = typeof import('./platform');
type Keys = typeof import('./state/storageKeys');

/** One page load of the lab inside ThreatReady: fresh modules (module state is per page). */
async function boot(): Promise<Platform & Keys> {
  vi.resetModules();
  const platform = await import('./platform');
  const keys = await import('./state/storageKeys');
  return { ...platform, ...keys };
}
const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  ({ ok: status >= 200 && status < 300, status, headers: { get: (h: string) => headers[h] ?? null }, json: async () => body }) as unknown as Response;
const shared = () => Object.keys(localStorage).filter((k) => (k.startsWith('threatwall:') || k.startsWith('tw-last-route')) && !k.includes(':u:') && k !== 'threatwall:legacy-migrated');

beforeEach(() => {
  vi.stubEnv('BASE_URL', '/labs/threatwall/');
  vi.stubGlobal('window', { location: { origin: 'http://tr.test' } });
  vi.stubGlobal('localStorage', new FakeStorage());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('/labs/api/me lookup', () => {
  it('retries once after a short Retry-After, then confirms the user', async () => {
    const { lookupPlatformUser } = await boot();
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(429, {}, { 'Retry-After': '1' })).mockResolvedValueOnce(reply(200, { id: 'u1', name: 'Ada' }));
    const sleep = vi.fn(async () => {});
    const r = await lookupPlatformUser('http://tr.test/labs/api/me', { fetchImpl, sleep });
    expect(r.user).toEqual({ id: 'u1', name: 'Ada' });
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('does not sit out a long Retry-After', async () => {
    const { lookupPlatformUser } = await boot();
    const fetchImpl = vi.fn().mockResolvedValue(reply(503, {}, { 'Retry-After': '30' }));
    const r = await lookupPlatformUser('http://tr.test/labs/api/me', { fetchImpl, sleep: vi.fn(async () => {}) });
    expect(r).toEqual({ user: null, problem: 'unavailable', retryAfter: 30 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('401 is signed out; a hang is cut off by the timeout', async () => {
    const { lookupPlatformUser } = await boot();
    expect((await lookupPlatformUser('x', { fetchImpl: vi.fn().mockResolvedValue(reply(401)) })).problem).toBe('signed-out');
    const hang = (_u: unknown, init?: RequestInit) => new Promise<Response>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    expect((await lookupPlatformUser('x', { fetchImpl: hang as typeof fetch, timeoutMs: 30 })).problem).toBe('unavailable');
  });
  it('platformUser records why the account was not confirmed', async () => {
    const p = await boot();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(429, {}, { 'Retry-After': '120' })));
    expect(await p.platformUser()).toBeNull();
    expect(p.platformIdentity()).toEqual({ problem: 'unavailable', retryAfter: 120 });
  });
});

describe('notice wording', () => {
  it('words the wait for people: 1 second, not "1 seconds"', async () => {
    const { waitText } = await boot();
    expect([1, 0, 30, 89, 90, 600].map(waitText)).toEqual(['1 second', '1 second', '30 seconds', '89 seconds', '2 minutes', '10 minutes']);
  });
});

describe('progress storage', () => {
  it('without a confirmed user, the lab never reads or writes localStorage', async () => {
    localStorage.setItem('threatwall:lab-state', '{"learner":"A"}');
    const p = await boot();
    p.setSessionOnlyStorage();
    expect(p.labStorage().getItem(p.labStateKey())).toBeNull();
    p.labStorage().setItem(p.labStateKey(), '{"learner":"B (tab only)"}');
    p.labStorage().setItem(p.lastRouteKey(), 'policy/rules/access');
    p.labStorage().setItem(p.backupKey(), 'x');
    expect(p.labStorage().getItem(p.labStateKey())).toBe('{"learner":"B (tab only)"}');
    expect(Object.keys(localStorage)).toEqual(['threatwall:lab-state']);
  });

  it('nothing is read or written before start-up has decided either', async () => {
    const p = await boot();
    p.labStorage().setItem(p.labStateKey(), '{}');
    expect(Object.keys(localStorage)).toEqual([]);
  });

  it('a /me failure, then a different user: that user starts with empty state', async () => {
    let p = await boot();
    p.setStorageNamespace('user-a');
    p.migrateLegacyKeys(p.LEGACY_STORAGE_KEYS, p.LEGACY_DISCARD_KEYS);
    p.labStorage().setItem(p.labStateKey(), '{"task":4,"by":"A"}');
    p = await boot();
    p.setSessionOnlyStorage();
    p.labStorage().setItem(p.labStateKey(), '{"task":7,"by":"A, failed lookup","adminPasswordHash":"x"}');
    p = await boot();
    p.setStorageNamespace('user-b');
    p.migrateLegacyKeys(p.LEGACY_STORAGE_KEYS, p.LEGACY_DISCARD_KEYS);
    expect(p.labStorage().getItem(p.labStateKey())).toBeNull();
    expect(shared()).toEqual([]);
    expect(localStorage.getItem('threatwall:lab-state:u:user-a')).toBe('{"task":4,"by":"A"}');
  });

  it('pre-namespacing progress goes to the first confirmed user once; the shared backup is dropped', async () => {
    localStorage.setItem('threatwall:lab-state', '{"task":3}');
    localStorage.setItem('tw-last-route', 'network/system/interfaces');
    localStorage.setItem('threatwall:lab-state:backup', '{"old":true}');
    let p = await boot();
    p.setStorageNamespace('user-a');
    p.migrateLegacyKeys(p.LEGACY_STORAGE_KEYS, p.LEGACY_DISCARD_KEYS);
    expect(p.labStorage().getItem(p.labStateKey())).toBe('{"task":3}');
    expect(p.labStorage().getItem(p.lastRouteKey())).toBe('network/system/interfaces');
    expect(localStorage.getItem('threatwall:lab-state:u:user-a:backup')).toBeNull();
    expect(shared()).toEqual([]);
    expect(localStorage.getItem(p.MIGRATED_KEY)).not.toBeNull();
    // A shared key that turns up later (an older build in another tab) is never handed to anyone.
    localStorage.setItem('threatwall:lab-state', '{"stray":true}');
    p = await boot();
    p.setStorageNamespace('user-b');
    p.migrateLegacyKeys(p.LEGACY_STORAGE_KEYS, p.LEGACY_DISCARD_KEYS);
    expect(p.labStorage().getItem(p.labStateKey())).toBeNull();
    expect(shared()).toEqual([]);
  });

  it('no migration when another account already has namespaced progress here', async () => {
    localStorage.setItem('threatwall:lab-state:u:user-c', '{"c":1}');
    localStorage.setItem('threatwall:lab-state', '{"task":9}');
    const p = await boot();
    p.setStorageNamespace('user-a');
    p.migrateLegacyKeys(p.LEGACY_STORAGE_KEYS, p.LEGACY_DISCARD_KEYS);
    expect(p.labStorage().getItem(p.labStateKey())).toBeNull();
    expect(localStorage.getItem('threatwall:lab-state:u:user-c')).toBe('{"c":1}');
    expect(shared()).toEqual([]);
  });
});
