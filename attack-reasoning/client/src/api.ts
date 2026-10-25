// Sign-in lives on onboard.threatready.io (the ThreatReady identity provider). The session cookie is
// shared across *.threatready.io (localhost cookies ignore the port in development).
/** This app's base path (/ar/). The API is under it: /ar/api. */
export const BASE = import.meta.env.BASE_URL;
// Empty VITE_ONBOARD_URL = onboard on the same origin (single-origin deployment).
const onboardEnv = import.meta.env.VITE_ONBOARD_URL as string | undefined;
export const ONBOARD_URL = (onboardEnv ?? 'http://localhost:5173').replace(/\/+$/, '');
const onboard = (path: string, next: string) => `${ONBOARD_URL}${path}?next=${encodeURIComponent(next)}`;
export const signIn = () => location.assign(onboard('/', location.href));
export const signUp = () => location.assign(`${onboard('/', location.href)}&mode=signup`);
export const signOut = () => location.assign(onboard('/signout', location.origin + BASE));
export const onboardLinks = { home: `${ONBOARD_URL}/app`, profile: `${ONBOARD_URL}/app/profile` };

/** A failed call. `retryAfterSec` comes from Retry-After (429/503); `details` from the error body (e.g. a reset time). */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public extra: { retryAfterSec?: number; details?: unknown } = {}) { super(message); }
  get retryAfterSec() { return this.extra.retryAfterSec; }
  get details() { return this.extra.details; }
}

/** Seconds from a Retry-After header (delta-seconds or an HTTP date); undefined when absent or unreadable. */
export function retryAfterOf(res: Response): number | undefined {
  const v = res.headers.get('retry-after');
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : undefined;
}

export async function api<T = any>(path: string): Promise<T> {
  let res: Response;
  try { res = await fetch(`${BASE}api${path}`, { credentials: 'include', cache: 'no-store' }); }
  catch { throw new ApiError(0, 'Cannot reach ThreatReady. Check your connection and retry.'); }
  // A success that isn't JSON (a proxy page, a dev-server restart) is an error, not data.
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  // A body that fails to parse (cut off when the page navigates away mid-response) is an error too;
  // returning {} would hand callers an object without the fields they expect.
  let json: any = {};
  if (isJson) {
    try { json = await res.json(); } catch { if (res.ok) throw new ApiError(0, 'The response was interrupted. Retry in a moment.', 'BAD_RESPONSE'); }
  }
  if (res.ok && !isJson) throw new ApiError(res.status, 'Unexpected response from the server. Retry in a moment.', 'BAD_RESPONSE');
  if (res.status === 401) { signIn(); throw new ApiError(401, 'Signing you in…', 'AUTH_REQUIRED'); }
  if (res.status === 403 && json.code === 'AUTH_ACCOUNT_REQUIRED') { signUp(); throw new ApiError(403, json.error, json.code); }
  if (res.status === 429 || res.status === 503) {
    const wait = retryAfterOf(res);
    throw new ApiError(res.status, typeof json.error === 'string' ? json.error : res.status === 429 ? `Too many requests. Try again in ${wait ?? 60} s.` : 'This part of ThreatReady is briefly unavailable. Try again in a moment.', json.code, { retryAfterSec: wait });
  }
  if (!res.ok) throw new ApiError(res.status, typeof json.error === 'string' ? json.error : 'Something went wrong on our side. Try again in a moment.', json.code);
  return json as T;
}
