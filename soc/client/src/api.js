// Thin fetch wrapper. Errors carry the server's message and any extra
// fields (validation problems, confirmation prompts).

// 429 and 503 always read as a person would say them, with when to retry (the server's own message
// when it sent one; a proxy's or gateway's page may carry none).
const waitText = (s) => (s > 0 ? `Try again in ${s >= 120 ? `${Math.ceil(s / 60)} minutes` : `${s} second${s === 1 ? '' : 's'}`}.` : 'Try again in a moment.');
function messageOf(status, body, retryAfter) {
  if (body?.message) return body.message;
  if (status === 429) return `Too many requests. ${waitText(retryAfter)}`;
  if (status === 503) return `The SOC simulation is briefly unavailable. ${waitText(retryAfter)}`;
  return body?.error || `Request failed (${status})`;
}

export class ApiError extends Error {
  constructor(status, body, retryAfter = 0) {
    super(messageOf(status, body, retryAfter));
    this.status = status;
    this.code = body?.error;
    this.body = body || {};
    this.retryAfter = retryAfter;
  }
}

// App-level listeners: a lost session shows the sign-in page,
// a newly earned badge opens the badge dialog over whatever screen is open.
const listeners = { noSession: new Set(), awards: new Set() };
export const onApi = (kind, fn) => { listeners[kind].add(fn); return () => listeners[kind].delete(fn); };
const emit = (kind, v) => listeners[kind].forEach((fn) => { try { fn(v); } catch { /* listener error */ } });

// The API sits under the page's base path (/ standalone, /labs/soc/ inside ThreatReady).
export const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');
// Full URL of an API path for links, downloads and the EventSource, which
// cannot go through call(): apiUrl('/api/me/export').
export const apiUrl = (url) => BASE + url;

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
    // no_session: this app's own sign-in ended; auth_required: the ThreatReady session ended (hosted).
    if (res.status === 401 && (data?.error === 'no_session' || data?.error === 'auth_required')) emit('noSession', data);
    const wait = Number(res.headers.get('Retry-After'));
    throw new ApiError(res.status, data, Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : 0);
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
  // How many live log streams this analyst has open, and the limit (why a stream was refused).
  streams: () => call('GET', '/api/streams'),
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
// `hosted`: signed in through ThreatReady (records belong to the platform account); `durable`: they are
// kept across restarts too, so they are saved with that account.
export const session = { me: null, homeUrl: null, dailyWipe: true, hosted: false, durable: false };
