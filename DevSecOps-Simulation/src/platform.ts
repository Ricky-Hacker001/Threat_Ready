/**
 * ThreatReady platform integration. Inside ThreatReady the lab is served at /labs/devsecops/ behind the platform
 * sign-in, and the Labs API next to it (/labs/api/me) names the signed-in user. Progress is then kept per account,
 * so the next person on a shared browser never continues someone else's labs. Standalone (any other base) nothing
 * here applies and the original storage keys are used.
 */

export interface PlatformUser {
  id: string;
  name: string;
}

const BASE = import.meta.env.BASE_URL;
/** Served under /labs/ means inside ThreatReady, where the platform strip above carries the ThreatReady mark. */
export const inPlatform = typeof window !== 'undefined' && BASE.startsWith('/labs/');

const TIMEOUT_MS = 4000;
let cached: Promise<PlatformUser | null> | null = null;

/** The signed-in ThreatReady user, or null standalone / when the API does not answer within a few seconds. */
export function platformUser(): Promise<PlatformUser | null> {
  if (!inPlatform) return Promise.resolve(null);
  return (cached ??= (async () => {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(new URL('../api/me', window.location.origin + BASE), { credentials: 'include', cache: 'no-store', signal: ctl?.signal });
      if (!res.ok) return null;
      const u = (await res.json()) as { id?: unknown; name?: unknown };
      if (typeof u?.id !== 'string' || !u.id) return null;
      return { id: u.id, name: typeof u.name === 'string' ? u.name.trim() : '' };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })());
}
