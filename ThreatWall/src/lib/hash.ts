/**
 * Lab-only password hashing. This is a simulator: nothing leaves the browser, but a learner may still type a
 * password they use elsewhere, and the lab state sits in localStorage on the shared ThreatReady origin. So the
 * administrator and local-user passwords are stored as salted PBKDF2-SHA256 (Web Crypto,
 * `pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>`), which a copied save cannot cheaply reverse.
 *
 * `hashPassword` is the original 32-bit FNV-1a: it still seeds the factory default and lab-internal values
 * (task checks compare against it). Hashes stored before the upgrade (FNV, or unsalted `sha256$<hex>`) still
 * verify and are re-hashed on that account's next successful login: the administrator's on the appliance login
 * page, a local user's on a simulated NetExtender or user login (Lab Tools).
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
const PBKDF2_PREFIX = 'pbkdf2-sha256$';
/** OWASP's guidance for PBKDF2-HMAC-SHA256 (about a quarter of a second on a laptop). */
export const PBKDF2_ITERATIONS = 600_000;
const subtle = (): SubtleCrypto | null => (typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null);
const toHex = (buf: ArrayBuffer | Uint8Array) => Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

async function pbkdf2(s: SubtleCrypto, pw: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await s.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return toHex(await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256));
}

/** Salted PBKDF2-SHA256 of the password; falls back to the legacy digest where Web Crypto is unavailable (plain-http dev hosts). */
export async function hashPasswordSecure(pw: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const s = subtle();
  if (!s) return hashPassword(pw);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${PBKDF2_PREFIX}${iterations}$${toHex(salt)}$${await pbkdf2(s, pw, salt, iterations)}`;
}

/** Compares against any stored format; `rehash` is set when an older format (or fewer iterations) matched and should be replaced. */
export async function verifyPassword(pw: string, stored: string): Promise<{ ok: boolean; rehash?: string }> {
  const s = subtle();
  if (stored.startsWith(PBKDF2_PREFIX)) {
    const [iter, salt, hash] = stored.slice(PBKDF2_PREFIX.length).split('$');
    const n = Number(iter);
    if (!s || !Number.isInteger(n) || n < 1 || n > 10_000_000 || !salt || !hash) return { ok: false };
    if ((await pbkdf2(s, pw, fromHex(salt), n)) !== hash) return { ok: false };
    return n < PBKDF2_ITERATIONS ? { ok: true, rehash: await hashPasswordSecure(pw) } : { ok: true };
  }
  let ok: boolean;
  if (stored.startsWith(SHA_PREFIX)) {
    if (!s) return { ok: false };
    ok = SHA_PREFIX + toHex(await s.digest('SHA-256', new TextEncoder().encode(`threatwall:${pw}`))) === stored;
  } else ok = hashPassword(pw) === stored;
  if (!ok) return { ok: false };
  const next = await hashPasswordSecure(pw);
  return { ok: true, rehash: next.startsWith(PBKDF2_PREFIX) ? next : undefined };
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
