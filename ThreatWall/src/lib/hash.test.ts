// Lab passwords are stored salted and slow (PBKDF2); older formats still verify and are upgraded on login.
import { describe, expect, it } from 'vitest';
import { PBKDF2_ITERATIONS, hashPassword, hashPasswordSecure, verifyPassword } from './hash';
import { factoryConfig } from '../state/baseline';
import { upgradeUserHash } from '../services/userService';

const legacySha = async (pw: string) =>
  'sha256$' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`threatwall:${pw}`))), (b) => b.toString(16).padStart(2, '0')).join('');

describe('lab password hashing', () => {
  it('stores a salted PBKDF2 hash with the full iteration count', async () => {
    const a = await hashPasswordSecure('Lab-Firewall#2026');
    const b = await hashPasswordSecure('Lab-Firewall#2026');
    expect(a).toMatch(new RegExp(`^pbkdf2-sha256\\$${PBKDF2_ITERATIONS}\\$[0-9a-f]{32}\\$[0-9a-f]{64}$`));
    expect(a).not.toBe(b); // a fresh salt each time: equal passwords do not give equal hashes
    expect(a).not.toContain('Lab-Firewall');
    expect(await verifyPassword('Lab-Firewall#2026', a)).toEqual({ ok: true });
    expect(await verifyPassword('lab-firewall#2026', a)).toEqual({ ok: false });
  });

  it('upgrades a hash with fewer iterations on a successful check', async () => {
    const weak = await hashPasswordSecure('Practice#Pass1', 1000);
    const v = await verifyPassword('Practice#Pass1', weak);
    expect(v.ok).toBe(true);
    expect(v.rehash).toMatch(new RegExp(`^pbkdf2-sha256\\$${PBKDF2_ITERATIONS}\\$`));
  });

  it('still accepts unsalted SHA-256 and FNV hashes from older saves, and offers a salted replacement', async () => {
    for (const stored of [await legacySha('Practice#Pass1'), hashPassword('Practice#Pass1')]) {
      const v = await verifyPassword('Practice#Pass1', stored);
      expect(v.ok).toBe(true);
      expect(v.rehash).toMatch(/^pbkdf2-sha256\$/);
      expect((await verifyPassword('wrong', stored)).ok).toBe(false);
    }
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect((await verifyPassword('x', 'pbkdf2-sha256$abc$$')).ok).toBe(false);
    expect((await verifyPassword('x', 'pbkdf2-sha256$99999999999$00$00')).ok).toBe(false);
  });
});

describe('local-user hashes from older saves', () => {
  const withUser = (passwordHash: string) => {
    const cfg = factoryConfig();
    return { ...cfg, users: { ...cfg.users, local: [{ id: 'u-priya', name: 'priya', passwordHash, groups: ['Everyone', 'Staff'], otp: false, vpnAccess: [], comment: '' }] } };
  };

  it('are replaced by a salted hash after a successful simulated login, and the new one verifies', async () => {
    const legacy = hashPassword('Practice#Pass1');
    const cfg = withUser(legacy);
    const v = await verifyPassword('Practice#Pass1', legacy);
    const next = upgradeUserHash(cfg, 'u-priya', legacy, v.rehash!);
    const stored = next.users.local[0].passwordHash;
    expect(stored).toMatch(new RegExp(`^pbkdf2-sha256\\$${PBKDF2_ITERATIONS}\\$`));
    expect(await verifyPassword('Practice#Pass1', stored)).toEqual({ ok: true });
    expect(next.users.local[0]).toEqual({ ...cfg.users.local[0], passwordHash: stored });
    expect(cfg.users.local[0].passwordHash).toBe(legacy); // pure: the input config is unchanged
  });

  it('are left alone when the password changed in the meantime', async () => {
    const cfg = withUser(await hashPasswordSecure('Changed#Pass22'));
    expect(upgradeUserHash(cfg, 'u-priya', hashPassword('Practice#Pass1'), 'pbkdf2-sha256$1$00$00')).toBe(cfg);
    expect(upgradeUserHash(cfg, 'u-nobody', cfg.users.local[0].passwordHash, 'pbkdf2-sha256$1$00$00')).toBe(cfg);
  });
});
