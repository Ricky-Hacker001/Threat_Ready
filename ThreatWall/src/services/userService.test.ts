/**
 * Legacy password hashes of local users are upgraded on the first successful login (security patch 2), to the salted
 * PBKDF2 format of lib/hash.ts. The upgrade is a compare-and-swap on the hash that was checked (upgradeUserHash).
 */
import { describe, expect, it } from 'vitest';
import { PBKDF2_ITERATIONS, hashPassword, hashPasswordSecure, verifyPassword } from '../lib/hash';
import { upgradeUserHash } from './userService';
import { factoryConfig } from '../state/baseline';

const withUser = (passwordHash: string) => {
  const cfg = factoryConfig();
  return { ...cfg, users: { ...cfg.users, local: [{ id: 'u1', name: 'alice', passwordHash, groups: ['Everyone'], otp: false, vpnAccess: [], comment: '' }] } };
};
const SALTED = new RegExp(`^pbkdf2-sha256\\$${PBKDF2_ITERATIONS}\\$[0-9a-f]{32}\\$[0-9a-f]{64}$`);

describe('local user password re-hash', () => {
  it('a legacy hash verifies once and comes back with its salted replacement', async () => {
    const legacy = hashPassword('Practice#Pass1');
    const v = await verifyPassword('Practice#Pass1', legacy);
    expect(v.ok).toBe(true);
    expect(v.rehash).toMatch(SALTED);
    expect(await verifyPassword('Practice#Pass1', v.rehash!)).toEqual({ ok: true });
    expect((await verifyPassword('wrong', legacy)).ok).toBe(false);
  });

  it("upgradeUserHash swaps only that user's hash and the new hash then verifies without a further rehash", async () => {
    const legacy = hashPassword('Practice#Pass1');
    const cfg = withUser(legacy);
    const v = await verifyPassword('Practice#Pass1', legacy);
    const next = upgradeUserHash(cfg, 'u1', legacy, v.rehash!);
    expect(next).not.toBe(cfg);
    expect(next.users.local[0]).toEqual({ ...cfg.users.local[0], passwordHash: v.rehash });
    expect(cfg.users.local[0].passwordHash).toBe(legacy); // immutable input
    const again = await verifyPassword('Practice#Pass1', next.users.local[0].passwordHash);
    expect(again).toEqual({ ok: true });
  });

  it('is a no-op for an unknown user, an empty hash, or an already-current hash', async () => {
    const current = await hashPasswordSecure('Practice#Pass1');
    const cfg = withUser(current);
    expect(upgradeUserHash(cfg, 'nobody', current, 'pbkdf2-sha256$1$00$00')).toBe(cfg);
    expect(upgradeUserHash(cfg, 'u1', current, '')).toBe(cfg);
    expect(upgradeUserHash(cfg, 'u1', current, current)).toBe(cfg);
  });
});
