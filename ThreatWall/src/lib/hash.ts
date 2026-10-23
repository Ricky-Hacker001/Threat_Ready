/**
 * Lab-only password hashing. This is a simulator: nothing leaves the browser, but we still avoid
 * storing a typed password in plain text in localStorage.
 *
 * The administrator password is stored as SHA-256 (`sha256$<hex>`, Web Crypto). `hashPassword` is
 * the original 32-bit FNV-1a: it still seeds the factory default and lab-internal values, and
 * verifies hashes stored before the upgrade, which are re-hashed on the next successful login.
 */
export function hashPassword(pw: string): string {
  let h = 0x811c9dc5;
  const s = `threatwall:${pw}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const SHA_PREFIX = 'sha256$';
const subtle = (): SubtleCrypto | null => (typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null);

/** SHA-256 of the password; falls back to the legacy digest where Web Crypto is unavailable (plain-http dev hosts). */
export async function hashPasswordSecure(pw: string): Promise<string> {
  const s = subtle();
  if (!s) return hashPassword(pw);
  const buf = await s.digest('SHA-256', new TextEncoder().encode(`threatwall:${pw}`));
  return SHA_PREFIX + Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares against either hash format; `rehash` is set when a legacy hash matched and should be replaced. */
export async function verifyPassword(pw: string, stored: string): Promise<{ ok: boolean; rehash?: string }> {
  if (stored.startsWith(SHA_PREFIX)) return { ok: (await hashPasswordSecure(pw)) === stored };
  if (hashPassword(pw) !== stored) return { ok: false };
  const next = await hashPasswordSecure(pw);
  return { ok: true, rehash: next.startsWith(SHA_PREFIX) ? next : undefined };
}

export function passwordProblems(pw: string, user: string): string[] {
  const p: string[] = [];
  if (pw.length < 12) p.push('At least 12 characters');
  if (!/[A-Z]/.test(pw)) p.push('An uppercase letter');
  if (!/[a-z]/.test(pw)) p.push('A lowercase letter');
  if (!/\d/.test(pw)) p.push('A number');
  if (!/[^A-Za-z0-9]/.test(pw)) p.push('A symbol');
  if (pw.toLowerCase() === 'password' || pw.toLowerCase().includes(user.toLowerCase())) p.push('Not the default or the username');
  return p;
}

export const uid = (): string => Math.random().toString(36).slice(2, 10);

/** Lab-only authenticator code (30-second window). Not a real TOTP secret — it never leaves the simulator. */
export function labTotp(user: string, ts: number): string {
  const n = parseInt(hashPassword(`${user}|totp|${Math.floor(ts / 30_000)}`).replace(/[^0-9a-f]/gi, '').slice(-8) || '0', 16);
  return String(n % 1_000_000).padStart(6, '0');
}
