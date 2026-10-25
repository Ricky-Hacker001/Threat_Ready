/**
 * ThreatReady platform integration. Inside ThreatReady the lab is served at /labs/threatwall/ behind the platform
 * sign-in, and the Labs API next to it (/labs/api/me) names the signed-in user. Progress is then kept per account,
 * so the next person on a shared browser never continues someone else's lab. If the account cannot be confirmed,
 * progress is kept for this tab only and the lab says so; it never falls back to a key other learners on this
 * browser could share. Standalone (any other base) nothing here applies and the original storage keys are used.
 */

export interface PlatformUser { id: string; name: string }

/** Why the signed-in user could not be confirmed inside ThreatReady. */
export type IdentityProblem = 'signed-out' | 'unavailable';

export interface IdentityResult {
  user: PlatformUser | null;
  problem: IdentityProblem | null;
  /** Seconds the server asked us to wait (429/503 Retry-After), when it said. */
  retryAfter: number | null;
}

const BASE = import.meta.env.BASE_URL;
/** Served under /labs/ means inside ThreatReady, where the platform strip above carries the ThreatReady mark. */
export const inPlatform = typeof window !== 'undefined' && BASE.startsWith('/labs/');

/** Each request to /labs/api/me gives up after this long. */
export const TIMEOUT_MS = 4000;
/** A 429/503 is retried once when its Retry-After is at most this long; a longer wait is not sat out on the boot screen. */
export const MAX_RETRY_WAIT_MS = 5000;

/** Retry-After as seconds (delta-seconds or an HTTP date), or null when absent or unreadable. */
export function parseRetryAfter(v: string | null, now = Date.now()): number | null {
  if (!v) return null;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const at = Date.parse(t);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** A wait in words for the notices: "1 second", "30 seconds", "2 minutes". */
export function waitText(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  return s < 90 ? `${s} second${s === 1 ? '' : 's'}` : `${Math.ceil(s / 60)} minutes`;
}

export interface LookupOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxRetryWaitMs?: number;
  /** Told how long we wait before the one retry, so the boot screen can say so. */
  onWait?: (seconds: number) => void;
}

/**
 * Ask the Labs API who is signed in. 401/403 (or no id) means signed out; 429/503 is retried once when the server
 * asks for a short wait (honouring Retry-After); anything else, a network error or the timeout means unavailable.
 */
export async function lookupPlatformUser(url: string, opts: LookupOptions = {}): Promise<IdentityResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const maxWait = opts.maxRetryWaitMs ?? MAX_RETRY_WAIT_MS;
  let retryAfter: number | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl?.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { credentials: 'include', cache: 'no-store', signal: ctl?.signal });
      if (res.status === 401 || res.status === 403) return { user: null, problem: 'signed-out', retryAfter: null };
      if (res.status === 429 || res.status === 503) {
        retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
        const waitMs = (retryAfter ?? 1) * 1000;
        if (attempt === 0 && waitMs <= maxWait) {
          opts.onWait?.(Math.max(1, Math.ceil(waitMs / 1000)));
          await sleep(waitMs);
          continue;
        }
        return { user: null, problem: 'unavailable', retryAfter };
      }
      if (!res.ok) return { user: null, problem: 'unavailable', retryAfter: null };
      const u = (await res.json()) as { id?: unknown; name?: unknown };
      if (typeof u?.id !== 'string' || !u.id) return { user: null, problem: 'signed-out', retryAfter: null };
      return { user: { id: u.id, name: typeof u.name === 'string' ? u.name.trim() : '' }, problem: null, retryAfter: null };
    } catch {
      // Network error, bad JSON or the timeout above.
      return { user: null, problem: 'unavailable', retryAfter };
    } finally {
      clearTimeout(timer);
    }
  }
  return { user: null, problem: 'unavailable', retryAfter };
}

let cached: Promise<IdentityResult> | null = null;
let identity: IdentityResult = { user: null, problem: null, retryAfter: null };

/** The signed-in ThreatReady user, or null standalone / when the account could not be confirmed (see platformIdentity). */
export function platformUser(onWait?: (seconds: number) => void): Promise<PlatformUser | null> {
  if (!inPlatform) return Promise.resolve(null);
  cached ??= lookupPlatformUser(new URL('../api/me', window.location.origin + BASE).href, { onWait }).then((r) => (identity = r));
  return cached.then((r) => r.user);
}

/** Inside ThreatReady, why the account could not be confirmed (null when it was, or standalone), and the server's suggested wait. */
export function platformIdentity(): { problem: IdentityProblem | null; retryAfter: number | null } {
  return { problem: identity.problem, retryAfter: identity.retryAfter };
}

/* ------------------------------------------------------------------ storage */

/** The parts of Storage the lab uses, so the tab-only store can stand in for localStorage. */
export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}

const local: KeyValueStore = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => localStorage.removeItem(k),
};

let namespace = '';
/** Inside ThreatReady nothing touches localStorage until a user is confirmed; until then (or if never) it is tab memory. */
let backend: KeyValueStore = inPlatform ? memoryStore() : local;

/** Where the lab's progress lives: localStorage standalone or for a confirmed user, otherwise this tab's memory. */
export function labStorage(): KeyValueStore {
  return backend;
}

/** Set once at start-up, before the store first reads, when a platform user is known. */
export function setStorageNamespace(userId: string): void {
  namespace = userId ? encodeURIComponent(userId) : '';
  backend = namespace || !inPlatform ? local : memoryStore();
}

/** Inside ThreatReady with no confirmed user: keep progress in memory for this tab only (the lab shows a notice). */
export function setSessionOnlyStorage(): void {
  namespace = '';
  backend = memoryStore();
}

/** `base` standalone or in tab-only memory; `base:u:<id>` for a signed-in ThreatReady user. */
export function userKey(base: string): string {
  return namespace ? `${base}:u:${namespace}` : base;
}

/** Set once the pre-namespacing keys have been dealt with on this browser (see migrateLegacyKeys). */
export const MIGRATED_KEY = 'threatwall:legacy-migrated';

/**
 * One-time, claim-safe migration of progress saved before keys were namespaced. It runs at the first boot on this
 * browser with a confirmed user: if no account has namespaced progress here yet, that user takes the old progress;
 * otherwise the old keys are dropped rather than handed to whoever opens the lab next. `discard` keys (the old shared
 * backup) are always dropped. Either way a marker is written, so later boots (any account) never migrate again.
 */
export function migrateLegacyKeys(bases: string[], discard: string[] = []): void {
  if (!namespace) return;
  try {
    const keys = Object.keys(localStorage);
    const claimed = localStorage.getItem(MIGRATED_KEY) !== null || keys.some((k) => bases.some((b) => k.startsWith(`${b}:u:`)));
    for (const base of bases) {
      const legacy = localStorage.getItem(base);
      if (legacy === null) continue;
      if (!claimed && localStorage.getItem(userKey(base)) === null) localStorage.setItem(userKey(base), legacy);
      localStorage.removeItem(base);
    }
    for (const k of discard) localStorage.removeItem(k);
    if (localStorage.getItem(MIGRATED_KEY) === null) localStorage.setItem(MIGRATED_KEY, String(Date.now()));
  } catch { /* storage unavailable: nothing to migrate */ }
}
