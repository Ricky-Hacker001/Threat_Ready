/**
 * ThreatReady platform integration. Inside ThreatReady the lab is served at /labs/aisec/ behind the
 * platform sign-in, and the Labs API next to it (/labs/api/me) names the signed-in user: the lab
 * then enters as that person (no name prompt), keeps progress per account and links back to the
 * catalog. Standalone (any other base) nothing here applies and the name screen is used.
 */
import { useEffect, useState } from "react";

export interface PlatformUser {
  id: string;
  name: string;
  /** The lab catalog (/labs/). */
  catalogUrl: string;
}

const BASE = import.meta.env.BASE_URL;
export const inPlatform = typeof window !== "undefined" && BASE.startsWith("/labs/");

/** How long the lab waits for each /labs/api/me request before opening without a confirmed user. */
const ME_TIMEOUT_MS = 5000;
/** A 429/503 is retried once when its Retry-After is at most this long; a longer wait is not sat out on the boot screen. */
export const MAX_RETRY_WAIT_MS = 5000;

/**
 * Inside ThreatReady, why the signed-in user could not be confirmed (null when it was, or standalone).
 * The lab then keeps progress for this tab only rather than under a key other learners could share.
 */
let identityProblem: "signed-out" | "unavailable" | null = null;
export function platformIdentityProblem(): "signed-out" | "unavailable" | null {
  return identityProblem;
}
/** Seconds ThreatReady asked us to wait (429/503 Retry-After) when the lookup gave up, if it said. */
let identityRetryAfter: number | null = null;
export function platformRetryAfter(): number | null {
  return identityRetryAfter;
}

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
  return s < 90 ? `${s} second${s === 1 ? "" : 's'}` : `${Math.ceil(s / 60)} minutes`;
}

let cached: Promise<PlatformUser | null> | null = null;
/**
 * The signed-in user, or null standalone / when it could not be confirmed (see platformIdentityProblem).
 * A 429/503 is retried once when ThreatReady asks for a short wait; `onWait` is told how long.
 */
export function platformUser(onWait?: (seconds: number) => void): Promise<PlatformUser | null> {
  if (!inPlatform) return Promise.resolve(null);
  return (cached ??= (async () => {
    const origin = window.location.origin;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = setTimeout(() => ctrl?.abort(), ME_TIMEOUT_MS);
      try {
        const res = await fetch(new URL("../api/me", origin + BASE), { credentials: "include", cache: "no-store", signal: ctrl?.signal });
        if (res.status === 429 || res.status === 503) {
          identityRetryAfter = parseRetryAfter(res.headers.get("Retry-After"));
          const waitMs = (identityRetryAfter ?? 1) * 1000;
          if (attempt === 0 && waitMs <= MAX_RETRY_WAIT_MS) {
            onWait?.(Math.max(1, Math.ceil(waitMs / 1000)));
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
        }
        if (!res.ok) {
          identityProblem = res.status === 401 || res.status === 403 ? "signed-out" : "unavailable";
          return null;
        }
        const u = (await res.json()) as { id?: unknown; name?: unknown };
        if (typeof u?.id !== "string" || !u.id) {
          identityProblem = "signed-out";
          return null;
        }
        identityRetryAfter = null;
        return { id: u.id, name: typeof u.name === "string" && u.name.trim() ? u.name.trim() : "Learner", catalogUrl: new URL("..", origin + BASE).pathname };
      } catch {
        // Network error, bad JSON or the timeout above.
        identityProblem = "unavailable";
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
    identityProblem = "unavailable";
    return null;
  })());
}

/** `undefined` while resolving, `null` standalone or signed out. */
export function usePlatformUser(): PlatformUser | null | undefined {
  const [u, setU] = useState<PlatformUser | null | undefined>(undefined);
  useEffect(() => {
    let on = true;
    void platformUser().then((v) => { if (on) setU(v); });
    return () => { on = false; };
  }, []);
  return u;
}
