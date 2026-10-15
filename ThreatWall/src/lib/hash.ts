/**
 * Lab-only password hashing (FNV-1a). This is a simulator: nothing leaves the browser,
 * but we still avoid storing the learner's typed password in plain text in localStorage.
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
