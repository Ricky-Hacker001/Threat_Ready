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

let cached: Promise<PlatformUser | null> | null = null;
export function platformUser(): Promise<PlatformUser | null> {
  if (!inPlatform) return Promise.resolve(null);
  return (cached ??= (async () => {
    try {
      const origin = window.location.origin;
      const res = await fetch(new URL("../api/me", origin + BASE), { credentials: "include", cache: "no-store" });
      if (!res.ok) return null;
      const u = (await res.json()) as { id?: unknown; name?: unknown };
      if (typeof u?.id !== "string" || !u.id) return null;
      return { id: u.id, name: typeof u.name === "string" && u.name.trim() ? u.name.trim() : "Learner", catalogUrl: new URL("..", origin + BASE).pathname };
    } catch {
      return null;
    }
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
