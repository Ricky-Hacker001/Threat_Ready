// Sign-in lives on onboard.threatready.io (the ThreatReady identity provider). The session cookie is
// shared across *.threatready.io (localhost cookies ignore the port in development).
export const ONBOARD_URL = (import.meta.env.VITE_ONBOARD_URL as string | undefined)?.replace(/\/+$/, '') || 'http://localhost:5173';
const onboard = (path: string, next: string) => `${ONBOARD_URL}${path}?next=${encodeURIComponent(next)}`;
export const signIn = () => location.assign(onboard('/', location.href));
export const signUp = () => location.assign(`${onboard('/', location.href)}&mode=signup`);
export const signOut = () => location.assign(onboard('/signout', location.origin + '/'));
export const onboardLinks = { home: `${ONBOARD_URL}/app`, profile: `${ONBOARD_URL}/app/profile` };

export class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }

export async function api<T = any>(path: string): Promise<T> {
  let res: Response;
  try { res = await fetch(`/api${path}`, { credentials: 'include' }); }
  catch { throw new ApiError(0, 'Cannot reach ThreatReady. Check your connection and retry.'); }
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) { signIn(); throw new ApiError(401, 'Signing you in…', 'AUTH_REQUIRED'); }
  if (res.status === 403 && json.code === 'AUTH_ACCOUNT_REQUIRED') { signUp(); throw new ApiError(403, json.error, json.code); }
  if (!res.ok) throw new ApiError(res.status, json.error || `Request failed (${res.status})`, json.code);
  return json as T;
}
