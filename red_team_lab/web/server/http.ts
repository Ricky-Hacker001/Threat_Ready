// A small, honest HTTP model shared by every tool in the lab (browser, proxy, repeater,
// terminal curl). Requests and responses are plain data so a captured request can be replayed
// in Repeater, diffed in Comparer and attached to a finding without transformation.

export interface HttpRequest {
  method: string;              // GET, POST, …
  path: string;                // /products  (no query string)
  query: string;               // raw query string without the leading '?', e.g. q=shoes
  headers: Record<string, string>;
  cookies: Record<string, string>;
  body: string;                // raw request body (may be form-encoded or JSON)
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  // Hint for the viewers; detection never relies on it.
  contentType: 'text/html' | 'application/json' | 'text/plain' | 'text/csv' | 'application/sql';
  timeMs: number;              // simulated response time
}

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** Parse "a=1&b=two&flag" into { a:'1', b:'two', flag:'' }. Values are URL-decoded; keys kept raw-ish. */
export function parseQuery(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (qs || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i === -1 ? part : part.slice(0, i);
    const v = i === -1 ? '' : part.slice(i + 1);
    out[safeDecode(k)] = safeDecode(v);
  }
  return out;
}

/** Parse a Cookie header value "a=1; b=2" into a map. */
export function parseCookieHeader(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h || '').split(';')) {
    const s = part.trim(); if (!s) continue;
    const i = s.indexOf('=');
    if (i === -1) continue;
    out[s.slice(0, i).trim()] = safeDecode(s.slice(i + 1).trim());
  }
  return out;
}

/** Parse an application/x-www-form-urlencoded or JSON body into a flat string map. */
export function parseBody(body: string, contentType = ''): Record<string, string> {
  const ct = contentType.toLowerCase();
  if (ct.includes('application/json')) {
    try { const o = JSON.parse(body || '{}'); const out: Record<string, string> = {}; for (const [k, v] of Object.entries(o)) out[k] = v == null ? '' : String(v); return out; } catch { return {}; }
  }
  return parseQuery(body.replace(/\+/g, ' '));
}

export function safeDecode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

export const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found',
  304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 429: 'Too Many Requests', 500: 'Internal Server Error',
};

export function resp(status: number, body: string, contentType: HttpResponse['contentType'] = 'text/html', headers: Record<string, string> = {}, timeMs = 0): HttpResponse {
  const base: Record<string, string> = { 'content-type': contentType + (contentType.startsWith('text') ? '; charset=utf-8' : ''), ...headers };
  return { status, statusText: STATUS_TEXT[status] || '', headers: lower(base), body, contentType, timeMs };
}

export function json(status: number, obj: any, headers: Record<string, string> = {}, timeMs = 0): HttpResponse {
  return resp(status, JSON.stringify(obj, null, 2), 'application/json', headers, timeMs);
}

function lower(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

/** Render a request back to wire text, for the proxy/repeater raw view. */
export function requestToText(r: HttpRequest, host: string): string {
  const target = r.path + (r.query ? `?${r.query}` : '');
  const lines = [`${r.method} ${target} HTTP/1.1`, `Host: ${host}`];
  const cookie = Object.entries(r.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const seen = new Set(['host', 'cookie']);
  for (const [k, v] of Object.entries(r.headers)) { if (seen.has(k.toLowerCase())) continue; lines.push(`${titleCase(k)}: ${v}`); }
  if (cookie) lines.push(`Cookie: ${cookie}`);
  lines.push('');
  lines.push(r.body || '');
  return lines.join('\r\n');
}

/** Render a response to wire text, for the proxy/repeater raw view. */
export function responseToText(r: HttpResponse): string {
  const lines = [`HTTP/1.1 ${r.status} ${r.statusText}`];
  for (const [k, v] of Object.entries(r.headers)) lines.push(`${titleCase(k)}: ${v}`);
  lines.push('');
  lines.push(r.body || '');
  return lines.join('\r\n');
}

function titleCase(k: string): string {
  return k.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('-');
}
