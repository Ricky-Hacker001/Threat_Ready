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

export class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }

export async function api<T = any>(path: string): Promise<T> {
  let res: Response;
  try { res = await fetch(`${BASE}api${path}`, { credentials: 'include' }); }
  catch { throw new ApiError(0, 'Cannot reach ThreatReady. Check your connection and retry.'); }
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) { signIn(); throw new ApiError(401, 'Signing you in…', 'AUTH_REQUIRED'); }
  if (res.status === 403 && json.code === 'AUTH_ACCOUNT_REQUIRED') { signUp(); throw new ApiError(403, json.error, json.code); }
  if (!res.ok) throw new ApiError(res.status, json.error || `Request failed (${res.status})`, json.code);
  return json as T;
}
