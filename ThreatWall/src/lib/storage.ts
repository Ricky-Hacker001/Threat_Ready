/**
 * Per-account localStorage. Inside ThreatReady the lab is served at /labs/threatwall/ behind the
 * platform sign-in and the Labs API next to it (/labs/api/me) names the signed-in user; every key
 * is then namespaced by that account so two people sharing a browser never see each other's lab.
 * Standalone (any other base) or signed out, the namespace is 'local'.
 */
const BASE = import.meta.env.BASE_URL;
const inPlatform = typeof window !== 'undefined' && BASE.startsWith('/labs/');

let namespace = 'local';

/** Resolve the namespace once, before the store first reads storage. */
export async function initStorageNamespace(): Promise<string> {
  if (!inPlatform) return namespace;
  try {
    const res = await fetch(new URL('../api/me', window.location.origin + BASE), { credentials: 'include', cache: 'no-store' });
    if (res.ok) {
      const u = (await res.json()) as { id?: unknown };
      if (typeof u?.id === 'string' && u.id) namespace = u.id.replace(/[^A-Za-z0-9_.@-]/g, '_');
    }
  } catch { /* standalone or signed out: stay local */ }
  return namespace;
}

export const storageNamespace = (): string => namespace;

/** A legacy key `<app>:<name>` becomes `<app>:<ns>:<name>`; one without a colon becomes `<key>:<ns>`. */
const parts = (legacy: string): [string, string] => {
  const i = legacy.indexOf(':');
  return i < 0 ? [`${legacy}:`, ''] : [legacy.slice(0, i + 1), legacy.slice(i)];
};
export const nsKey = (legacy: string): string => {
  const [head, tail] = parts(legacy);
  return head + namespace + tail;
};

/**
 * One-time migration of a key written before namespacing: it is claimed by the first account that
 * boots on this browser when no namespaced copy exists yet (so a learner upgrading keeps their
 * progress), then removed. Once any namespaced copy exists the old key is never read again.
 */
export function migrateLegacyKey(legacy: string): void {
  try {
    const old = localStorage.getItem(legacy);
    if (old === null) return;
    const mine = nsKey(legacy);
    const [head, tail] = parts(legacy);
    const claimed = Object.keys(localStorage).some((k) => k !== legacy && k.startsWith(head) && k.endsWith(tail) && k.length > head.length + tail.length);
    if (localStorage.getItem(mine) === null && !claimed) localStorage.setItem(mine, old);
    localStorage.removeItem(legacy);
  } catch { /* storage unavailable */ }
}
