// The Attack Reasoning API lives in the ThreatReady monolith (InterviewPrep's @threatready/api, the
// `reasoning` module; ADD L17b). This origin's browser only ever talks to this origin (CSP
// connect-src 'self'), so /v1/* is forwarded here: cookie, Origin and body go through unchanged, the
// monolith's guard chain decides, and its response (JSON, error envelope or SSE) streams back.
import http from 'node:http';
import https from 'node:https';
import type { Request, Response } from 'express';

export interface ProxyOptions {
  /** Where this server reaches the monolith's API (in-VPC in AWS), e.g. http://localhost:3100 */
  target: string;
  /** Header the gateway sets with the visitor's IP, when one is configured (deploy/gateway.mjs). */
  clientIpHeader?: string;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
/** Headers never copied from the browser's request: hop-by-hop, any Proxy-*, and the trusted client-IP header (set below). */
const dropIncoming = (name: string, clientIpHeader?: string) => HOP_BY_HOP.has(name) || name.startsWith('proxy-') || name === clientIpHeader;

/**
 * True when the request path, once percent-decoded and dot-segment-normalised, could reach the
 * monolith's internal API (`/internal/...`) or escape the /v1 prefix with `..`. Such requests are
 * answered 404 here rather than forwarded.
 */
export function reachesInternal(originalUrl: string): boolean {
  const raw = originalUrl.split(/[?#]/)[0];
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { return true; }
  // Decode twice: a double-encoded %252e%252e may be decoded again by the upstream.
  try { decoded = decodeURIComponent(decoded); } catch { return true; }
  const path = decoded.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)\.\.?(\/|$)/.test(path)) return true;
  return /(^|\/)internal(\/|$)/.test(path);
}

/** Express handler that streams a request to the monolith and the response back, without buffering (SSE-safe). */
export function proxyToApi(opts: ProxyOptions) {
  const target = new URL(opts.target);
  const client = target.protocol === 'https:' ? https : http;
  const ipHeader = opts.clientIpHeader?.toLowerCase();
  return (req: Request, res: Response) => {
    if (reachesInternal(req.originalUrl)) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, request_id: 'req_gateway' } }); return; }
    const headers: http.OutgoingHttpHeaders = {};
    // The cookie header goes through: the monolith resolves the ThreatReady session from it.
    for (const [k, v] of Object.entries(req.headers)) if (!dropIncoming(k, ipHeader) && v !== undefined) headers[k] = v;
    headers['x-forwarded-host'] = req.headers.host ?? '';
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] ?? req.protocol;
    // The visitor's IP is always written here from the connection (req.ip honours Express's
    // `trust proxy` setting): a learner-supplied value in this header is never forwarded.
    if (ipHeader) headers[ipHeader] = req.ip ?? '';
    const upstream = client.request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: req.method, path: req.originalUrl, headers },
      (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) out[k] = v;
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      },
    );
    upstream.setTimeout(0);
    upstream.on('error', () => {
      if (!res.headersSent) res.status(502).json({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The assessment service is restarting. Try again shortly.', retryable: true, request_id: 'req_gateway' } });
      else res.end();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  };
}

/** One JSON call to the monolith's internal API with the shared token (summary and AI usage for onboard). */
export async function internalGet(target: string, path: string, token: string, timeoutMs = 5000): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${target.replace(/\/+$/, '')}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body };
}
