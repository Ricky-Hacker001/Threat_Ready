/** Legacy FNV password hashes of local users are upgraded to SHA-256 on the first successful login (security patch 2). */
import { describe, expect, it } from 'vitest';
import { hashPassword, hashPasswordSecure, verifyPassword } from '../lib/hash';
import { rehashUser } from './userService';
import { factoryConfig } from '../state/baseline';

const withUser = (passwordHash: string) => {
  const cfg = factoryConfig();
  return { ...cfg, users: { ...cfg.users, local: [{ id: 'u1', name: 'alice', passwordHash, groups: ['Everyone'], otp: false, vpnAccess: [], comment: '' }] } };
};

describe('local user password re-hash', () => {
  it('a legacy hash verifies once and comes back with its SHA-256 replacement', async () => {
    const legacy = hashPassword('Practice#Pass1');
    const v = await verifyPassword('Practice#Pass1', legacy);
    expect(v.ok).toBe(true);
    expect(v.rehash).toBe(await hashPasswordSecure('Practice#Pass1'));
    expect(v.rehash!.startsWith('sha256$')).toBe(true);
    expect((await verifyPassword('wrong', legacy)).ok).toBe(false);
  });

  it('rehashUser swaps only that user\'s hash and the new hash then verifies without a further rehash', async () => {
    const legacy = hashPassword('Practice#Pass1');
    const cfg = withUser(legacy);
    const v = await verifyPassword('Practice#Pass1', legacy);
    const next = rehashUser(cfg, 'u1', v.rehash!);
    expect(next).not.toBe(cfg);
    expect(next.users.local[0]).toEqual({ ...cfg.users.local[0], passwordHash: v.rehash });
    expect(cfg.users.local[0].passwordHash).toBe(legacy); // immutable input
    const again = await verifyPassword('Practice#Pass1', next.users.local[0].passwordHash);
    expect(again).toEqual({ ok: true });
  });

  it('is a no-op for an unknown user, an empty hash, or an already-current hash', async () => {
    const sha = await hashPasswordSecure('Practice#Pass1');
    const cfg = withUser(sha);
    expect(rehashUser(cfg, 'nobody', 'sha256$00')).toBe(cfg);
    expect(rehashUser(cfg, 'u1', '')).toBe(cfg);
    expect(rehashUser(cfg, 'u1', sha)).toBe(cfg);
  });
});
