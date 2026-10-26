// The Attack Reasoning API lives in the ThreatReady monolith (InterviewPrep's @threatready/api, the
// `reasoning` module; ADD L17b). This origin's browser only ever talks to this origin (CSP
// connect-src 'self'), so /v1/* is forwarded here: cookie, Origin and body go through unchanged, the
// monolith's guard chain decides, and its response (JSON, error envelope or SSE) streams back.
import http from 'node:http';
import https from 'node:https';
import type { Request, Response } from 'express';
import { CLIENT_IP_HEADER } from './ratelimit';
import { requestId } from './requestId';

export interface ProxyOptions {
  /** Where this server reaches the monolith's API (in-VPC in AWS), e.g. http://localhost:3100 */
  target: string;
  /** Header the monolith reads the visitor's IP from (its CLIENT_IP_HEADER), when it reads one. */
  clientIpHeader?: string;
  /** The visitor's IP as this app decided it (the rate limiter's key). Default: req.ip. */
  ipOf?: (req: Request) => string;
  /** Largest request body forwarded, declared or chunked (default 256 KiB; the engine itself accepts 200 kB of JSON). */
  maxBodyBytes?: number;
  /**
   * The path this handler is mounted at in the engine's API (e.g. '/v1'): the request goes upstream as
   * mountPath + its path below the mount, so it works wherever this app is mounted (under /ar on the
   * single-origin gateway). Default: the request's full original URL.
   */
  mountPath?: string;
}

const MAX_BODY_BYTES = 256 * 1024;
/** The engine's error envelope, with the request's id (the gateway's, or minted by this app). */
const engineError = (rid: string, code: string, message: string, retryable = false) => ({ error: { code, message, retryable, request_id: rid } });

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
/** Headers never copied from the browser's request: hop-by-hop, any Proxy-*, and any client-IP header (written below from what this app decided). */
const dropIncoming = (name: string, clientIpHeader?: string) => HOP_BY_HOP.has(name) || name.startsWith('proxy-') || name === clientIpHeader || name === CLIENT_IP_HEADER;
/** Methods that carry no request body here: a body sent with one is never forwarded. */
const BODYLESS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE']);

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

/**
 * Express handler that streams a request to the monolith and the response back, without buffering
 * (SSE-safe). Framing is decided here, never inherited: a body is forwarded only for methods that
 * carry one, with the Content-Length Node already enforced on the way in (or chunked), so bytes the
 * browser sent after a bodyless request can never reach the monolith as a second request (audit OPS-REG0).
 * A body is counted on the way through: past `maxBodyBytes` (declared or chunked) the request is
 * answered 413 here and the upstream request is dropped, because the gateway in front caps only
 * declared lengths.
 */
export function proxyToApi(opts: ProxyOptions) {
  const target = new URL(opts.target);
  const client = target.protocol === 'https:' ? https : http;
  const ipHeader = opts.clientIpHeader?.toLowerCase();
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  return (req: Request, res: Response) => {
    const rid = requestId(req);
    const upstreamPath = opts.mountPath !== undefined ? `${opts.mountPath}${req.url}` : req.originalUrl;
    if (reachesInternal(req.originalUrl) || reachesInternal(upstreamPath)) { res.status(404).json(engineError(rid, 'NOT_FOUND', 'Not found.')); return; }
    const declared = req.headers['content-length'];
    // Node's parser already refuses both framings at once; this keeps the rule explicit here.
    if (declared !== undefined && req.headers['transfer-encoding'] !== undefined) { res.status(400).set('Connection', 'close').json(engineError(rid, 'BAD_REQUEST', 'Conflicting request framing.')); req.resume(); return; }
    const tooLarge = () => { res.status(413).set('Connection', 'close').json(engineError(rid, 'PAYLOAD_TOO_LARGE', 'The request is too large.')); req.resume(); };
    if (declared !== undefined && Number(declared) > maxBody) { tooLarge(); return; }
    const headers: http.OutgoingHttpHeaders = {};
    // The cookie header goes through: the monolith resolves the ThreatReady session from it.
    for (const [k, v] of Object.entries(req.headers)) if (!dropIncoming(k, ipHeader) && v !== undefined) headers[k] = v;
    headers['x-forwarded-host'] = req.headers.host ?? '';
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] ?? req.protocol;
    // The visitor's IP is what this app decided (the trusted gateway's header, or the connection):
    // a learner-supplied value is never forwarded.
    if (ipHeader) headers[ipHeader] = opts.ipOf?.(req) ?? req.ip ?? '';
    headers['x-request-id'] = rid; // the gateway's id follows the request into the engine's logs
    const withBody = !BODYLESS.has(req.method) && (req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined);
    // Node checked an incoming Content-Length against the bytes it delivers; a chunked body is re-chunked by Node.
    if (withBody && req.headers['content-length'] !== undefined) headers['content-length'] = req.headers['content-length'];
    if (!withBody && !BODYLESS.has(req.method)) headers['content-length'] = '0';
    const upstream = client.request(
      { protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: req.method, path: upstreamPath, headers },
      (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) out[k] = v;
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      },
    );
    upstream.setTimeout(0);
    let refused = false;
    upstream.on('error', (err) => {
      if (refused) return; // destroyed here on purpose (body over the cap): already answered 413
      console.error(`[${rid}] ${req.method} ${req.originalUrl}: reasoning engine unreachable: ${err.message}`);
      if (!res.headersSent) res.status(502).json(engineError(rid, 'UPSTREAM_UNAVAILABLE', 'The assessment service is restarting. Try again shortly.', true));
      else res.end();
    });
    req.on('aborted', () => upstream.destroy());
    if (withBody) {
      let seen = 0;
      req.on('data', (chunk: Buffer) => {
        seen += chunk.length;
        if (seen <= maxBody || refused) return;
        // Past the cap: nothing more goes upstream, and the rest of the body is read and discarded.
        refused = true;
        req.unpipe(upstream);
        upstream.destroy();
        if (!res.headersSent) tooLarge(); else res.end();
      });
      req.pipe(upstream);
    } else {
      req.resume(); // discard anything sent with a bodyless request
      upstream.end();
    }
  };
}

/** One JSON call to the monolith's internal API with this app's caller token (summary and AI usage for onboard). */
export async function internalGet(target: string, path: string, token: string, rid?: string, timeoutMs = 5000): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${target.replace(/\/+$/, '')}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(rid ? { 'x-request-id': rid } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body };
}
