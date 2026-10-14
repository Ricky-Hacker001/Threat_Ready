const LS = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } } };
export const store = LS;

// Sign-in lives on onboard.threatready.io (the ThreatReady identity provider). The session cookie is
// shared across *.threatready.io (localhost cookies ignore the port in development).
/** This app's base path (/labs/). The API is under it: /labs/api. */
export const BASE = import.meta.env.BASE_URL;
// Empty VITE_ONBOARD_URL = onboard on the same origin (single-origin deployment).
const onboardEnv = import.meta.env.VITE_ONBOARD_URL as string | undefined;
export const ONBOARD_URL = (onboardEnv ?? 'http://localhost:5173').replace(/\/+$/, '');
const onboard = (path: string, next: string) => `${ONBOARD_URL}${path}?next=${encodeURIComponent(next)}`;
/** Sign in on onboard, then come back to this exact page. */
export const signIn = () => location.assign(onboard('/', location.href));
/** A trial session (no account) can't use labs: create an account on onboard, then come back. */
export const signUp = () => location.assign(`${onboard('/', location.href)}&mode=signup`);
/** One sign-out for every ThreatReady app. */
export const signOut = () => location.assign(onboard('/signout', location.origin + BASE));
export const onboardLinks = { home: `${ONBOARD_URL}/app`, profile: `${ONBOARD_URL}/app/profile` };

let onConn: (ok: boolean) => void = () => {};
export const onConnection = (f: (ok: boolean) => void) => { onConn = f; };
export class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }

export async function api(path: string, body?: any, method?: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BASE}api${path}`, { method: method || (body !== undefined ? 'POST' : 'GET'), credentials: 'include', cache: 'no-store', headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch { onConn(false); throw new ApiError(0, 'Cannot reach the lab server. Check your connection and retry.'); }
  onConn(true);
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
  if (!res.ok) throw new ApiError(res.status, json.error || `Request failed (${res.status})`, json.code);
  return json;
}
export const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `r-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

const ACC = '123456789012', R = 'ap-south-1';
export const arn = {
  user: (n: string) => `arn:aws:iam::${ACC}:user/${n}`, role: (n: string) => `arn:aws:iam::${ACC}:role/${n}`,
  bucket: (b: string) => `arn:aws:s3:::${b}`, key: (id: string) => `arn:aws:kms:${R}:${ACC}:key/${id}`,
  secret: (n: string) => `arn:aws:secretsmanager:${R}:${ACC}:secret:${n}`, fn: (n: string) => `arn:aws:lambda:${R}:${ACC}:function:${n}`,
  logGroup: (n: string) => `arn:aws:logs:${R}:${ACC}:log-group:${n}:*`, trail: (n: string) => `arn:aws:cloudtrail:${R}:${ACC}:trail/${n}`,
};
export const fmt = (iso?: string | null) => { if (!iso) return '—'; const d = new Date(iso); if (isNaN(+d)) return iso; return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST'; };
