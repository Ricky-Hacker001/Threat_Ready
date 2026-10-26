// Thin fetch wrapper. Errors carry the server's message and any extra
// fields (validation problems, confirmation prompts).

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error;
    this.body = body || {};
  }
}

// App-level listeners: a lost session shows the sign-in page,
// a newly earned badge opens the badge dialog over whatever screen is open.
const listeners = { noSession: new Set(), awards: new Set() };
export const onApi = (kind, fn) => { listeners[kind].add(fn); return () => listeners[kind].delete(fn); };
const emit = (kind, v) => listeners[kind].forEach((fn) => { try { fn(v); } catch { /* listener error */ } });

// The API sits under the page's base path (/ standalone, /labs/soc/ inside ThreatReady).
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');
/** An API path (`/api/...`) resolved under the base path: for EventSource, downloads and links, which don't go through call(). */
export const apiUrl = (path) => BASE + path;

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && data?.error === 'no_session') emit('noSession', data);
    throw new ApiError(res.status, data);
  }
  if (data && Array.isArray(data.awards) && data.awards.length) emit('awards', data.awards);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  // Session and record
  sessionInfo: () => call('GET', '/api/session/info'),
  signIn: (token) => call('POST', '/api/session', { token }),
  signInLocal: (name) => call('POST', '/api/session/local', { name }),
  signOut: () => call('POST', '/api/session/logout'),
  me: () => call('GET', '/api/me'),
  levels: () => call('GET', '/api/levels'),
  level: (id) => call('GET', `/api/levels/${enc(id)}`),
  attempts: (limit = 20) => call('GET', `/api/attempts?limit=${limit}`),
  attempt: (id) => call('GET', `/api/attempts/${enc(id)}`),
  startAttempt: (scenarioId) => call('POST', '/api/attempts', { scenarioId }),
  abandon: (id) => call('POST', `/api/attempts/${enc(id)}/abandon`),
  awards: () => call('GET', '/api/awards'),
  report: () => call('GET', '/api/report'),

  // Cases
  scenarios: () => call('GET', '/api/scenarios'),
  cases: () => call('GET', '/api/cases'),
  getCase: (id) => call('GET', `/api/cases/${id}`),
  deleteCase: (id) => call('DELETE', `/api/cases/${id}`),
  ack: (id) => call('POST', `/api/cases/${id}/ack`),
  logs: (id, { q = '', source = '', limit = 100, offset = 0, from, to, order } = {}) => {
    const p = new URLSearchParams({ q, source, limit, offset });
    if (from !== undefined) p.set('from', from);
    if (to !== undefined) p.set('to', to);
    if (order) p.set('order', order);
    return call('GET', `/api/cases/${id}/logs?${p}`);
  },
  events: (id, ids) => call('GET', `/api/cases/${id}/events?ids=${enc(ids.join(','))}`),
  pin: (id, eventId, note) => call('POST', `/api/cases/${id}/pins`, { eventId, note }),
  unpin: (id, eventId) => call('DELETE', `/api/cases/${id}/pins/${enc(eventId)}`),
  addIoc: (id, value, type) => call('POST', `/api/cases/${id}/iocs`, { value, type }),
  removeIoc: (id, value) => call('POST', `/api/cases/${id}/iocs/remove`, { value }),
  note: (id, text) => call('POST', `/api/cases/${id}/notes`, { text }),
  draft: (id, draft) => call('PUT', `/api/cases/${id}/draft`, draft),
  tool: (id, tool, input, filter) => call('POST', `/api/cases/${id}/tools/${tool}`, { input, filter }),
  action: (id, body) => call('POST', `/api/cases/${id}/actions`, body),
  submit: (id, body) => call('POST', `/api/cases/${id}/submit`, body),
  hint: (id, stageId, fieldId) => call('POST', `/api/cases/${id}/hint`, { stageId, fieldId }),
  heartbeat: (id, visible) => call('POST', `/api/cases/${id}/heartbeat`, { visible }),
};

// Newbie Demo Mode and the homepage walkthrough. Separate from the case API.
export const demoApi = {
  info: () => call('GET', '/api/demo/info'),
  start: (body) => call('POST', '/api/demo/start', body),
  state: (id) => call('GET', `/api/demo/${id}`),
  check: (id, beat, data, quiet) => call('POST', `/api/demo/${id}/check`, { beat, data, quiet }),
  goto: (id, beat) => call('POST', `/api/demo/${id}/goto`, { beat }),
  skip: (id, beat) => call('POST', `/api/demo/${id}/skip`, { beat }),
  status: (id, status) => call('POST', `/api/demo/${id}/status`, { status }),
  reset: (id, nonce) => call('POST', `/api/demo/${id}/reset`, { nonce }),
  summary: (id) => call('GET', `/api/demo/${id}/summary`),
  preview: (point) => call('POST', '/api/tour/preview', { point }),
};

// The signed-in analyst, set at start-up or sign-in (App.jsx).
export const session = { me: null, homeUrl: null };
