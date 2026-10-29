import { safeNext } from "@threatready/contracts";

/**
 * Cross-app sign-in. An app (interviewprep., labs., ar.) with no session sends
 * the browser to onboard with ?next=<where to return>. The target is kept in
 * sessionStorage so it survives switching auth views, email verification and
 * the OAuth round trip, then used once by AppShell after sign-in.
 */
const KEY = "tr_next";
const BOUNCE_KEY = "tr_next_bounce";
const BOUNCE_WINDOW_MS = 15_000;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Call once at startup: captures ?next= from the URL. */
export function captureNext(): void {
  const next = new URLSearchParams(window.location.search).get("next");
  if (next) storage()?.setItem(KEY, next);
}

/** Return here after the next sign-in (an expired session inside onboard itself). */
export function rememberNext(url: string): void {
  storage()?.setItem(KEY, url);
}

export function pendingNext(): string | null {
  return storage()?.getItem(KEY) ?? null;
}

export function clearNext(): void {
  storage()?.removeItem(KEY);
}

/**
 * The validated return target, or null: an allowed origin and, with
 * `allowedPrefixes`, inside an app's home or onboard's /app (never /signout or
 * /api/… on a shared origin). Refuses a target we just sent the browser to
 * within the last few seconds: if that app bounced straight back, redirecting
 * again would loop forever.
 */
export function takeNext(
  allowedOrigins: readonly string[],
  allowedPrefixes?: readonly string[],
): { url: string | null; bounced: string | null } {
  const raw = pendingNext();
  clearNext();
  const url = safeNext(raw, allowedOrigins, allowedPrefixes);
  if (!url) return { url: null, bounced: null };
  const s = storage();
  try {
    const last = JSON.parse(s?.getItem(BOUNCE_KEY) ?? "null") as { url: string; at: number } | null;
    if (last && last.url === url && Date.now() - last.at < BOUNCE_WINDOW_MS) {
      s?.removeItem(BOUNCE_KEY);
      return { url: null, bounced: url };
    }
  } catch {
    /* ignore malformed */
  }
  s?.setItem(BOUNCE_KEY, JSON.stringify({ url, at: Date.now() }));
  return { url, bounced: null };
}

/** The app a URL belongs to: the registered app with the longest matching base URL. */
export function appForUrl<T extends { url: string }>(apps: T[], url: string): T | undefined {
  return apps.filter((a) => url.startsWith(a.url) || url === a.url.replace(/\/$/, "")).sort((a, b) => b.url.length - a.url.length)[0];
}

/**
 * The browser came to /signout from a ThreatReady page: an app's own "Sign out" (InterviewPrep, Labs,
 * Attack Reasoning and Red Team all link to /signout?next=…). From another ThreatReady host the
 * referrer carries only its origin (Referrer-Policy strict-origin-when-cross-origin), so a registered
 * app origin is enough. On onboard's own origin (one host serving every app) the page must also be
 * inside an app's home or /app, never the sign-in page or /signout itself. A cross-site page can
 * only hide its referrer, which reads as "not from the platform".
 */
export function cameFromPlatform(
  referrer: string,
  here: string,
  appOrigins: readonly string[],
  homes: readonly string[],
): boolean {
  let from: URL;
  try {
    from = new URL(referrer);
  } catch {
    return false;
  }
  if (from.origin !== new URL(here).origin) return appOrigins.includes(from.origin);
  return safeNext(referrer, [from.origin], homes) !== null;
}

/**
 * Business sign-up: the account is created first (the same sign-up as everyone), and the organisation
 * right after the first sign-in, from what the "For your team" tab remembered here. One use.
 */
const PENDING_ORG_KEY = "tr_pending_org";
export interface PendingOrg {
  name: string;
  segment: "business" | "institute";
}
export function rememberPendingOrg(org: PendingOrg): void {
  storage()?.setItem(PENDING_ORG_KEY, JSON.stringify(org));
}
export function takePendingOrg(): PendingOrg | null {
  const s = storage();
  const raw = s?.getItem(PENDING_ORG_KEY);
  if (!raw) return null;
  s?.removeItem(PENDING_ORG_KEY);
  try {
    const v = JSON.parse(raw) as Partial<PendingOrg>;
    if (typeof v.name === "string" && (v.segment === "business" || v.segment === "institute")) return { name: v.name, segment: v.segment };
  } catch {
    /* malformed */
  }
  return null;
}
export function peekPendingOrg(): PendingOrg | null {
  const raw = storage()?.getItem(PENDING_ORG_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingOrg>;
    return typeof v.name === "string" && (v.segment === "business" || v.segment === "institute") ? { name: v.name, segment: v.segment } : null;
  } catch {
    return null;
  }
}
