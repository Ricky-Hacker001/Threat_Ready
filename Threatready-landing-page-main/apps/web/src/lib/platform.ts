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

export function pendingNext(): string | null {
  return storage()?.getItem(KEY) ?? null;
}

export function clearNext(): void {
  storage()?.removeItem(KEY);
}

/**
 * The validated return target, or null. Refuses a target we just sent the
 * browser to within the last few seconds: if that app bounced straight back,
 * redirecting again would loop forever.
 */
export function takeNext(allowedOrigins: readonly string[]): { url: string | null; bounced: string | null } {
  const raw = pendingNext();
  clearNext();
  const url = safeNext(raw, allowedOrigins);
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
