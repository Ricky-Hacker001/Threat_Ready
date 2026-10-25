// Standalone API client. The lab runs under /lab/ ; its API is at /lab/api. When not signed in the
// app offers a local dev login (no external identity provider needed).
export const BASE = import.meta.env.BASE_URL; // "/lab/"

export class ApiError extends Error { constructor(public status: number, message: string, public code?: string, public body?: any) { super(message); } }

async function req<T = any>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try { res = await fetch(`${BASE}api${path}`, { credentials: 'include', cache: 'no-store', ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers || {}) } }); }
  catch { throw new ApiError(0, 'Cannot reach the lab server.'); }
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  let json: any = {};
  if (isJson) { try { json = await res.json(); } catch { if (res.ok) throw new ApiError(0, 'The response was interrupted.'); } }
  // Prefer the human-readable `message` over `error` — the hosted-lab gate puts a machine code in
  // `error` (e.g. "rate_limited", "auth_unavailable") and the readable text, with when to retry, in
  // `message` (UX-REG5). This app's own limiter puts the readable text in `error` and has no message,
  // so the fallback still reads well. We never surface a bare code or "Request failed (429)".
  if (!res.ok) throw new ApiError(res.status, json.message || json.error || `Something went wrong (HTTP ${res.status}). Please try again.`, json.code, json);
  return json as T;
}

export const api = {
  get: <T = any>(p: string) => req<T>(p),
  post: <T = any>(p: string, body?: any) => req<T>(p, { method: 'POST', body: body == null ? undefined : JSON.stringify(body) }),
  me: () => req('/me'),
  health: () => req('/health'),
  devLogin: (name: string) => req('/dev/login', { method: 'POST', body: JSON.stringify({ name }) }),
  devLogout: () => req('/dev/logout', { method: 'POST', body: '{}' }),
  catalog: () => req('/catalog'),
  definition: (labId: string) => req(`/labs/${labId}`),
  startSession: (labId: string, mode?: string) => req(`/labs/${labId}/sessions`, { method: 'POST', body: JSON.stringify(mode ? { mode } : {}) }),
  snapshot: (sid: string) => req(`/sessions/${sid}`),
  report: (sid: string) => req(`/sessions/${sid}/report`),
  reset: (sid: string) => req(`/sessions/${sid}/reset`, { method: 'POST', body: JSON.stringify({ confirm: 'RESET' }) }),
  action: (sid: string, type: string, params: any = {}) => req(`/sessions/${sid}/actions`, { method: 'POST', body: JSON.stringify({ type, params, requestId: rid() }) }),
};

let seq = 0;
export function rid() { return `rq-${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
