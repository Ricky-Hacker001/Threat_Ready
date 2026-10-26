// Request correlation. The gateway stamps `x-request-id` on every inbound request; this app echoes it
// (or mints one when absent) on the response, in every JSON error envelope (`requestId`) and in every
// error log line, so a learner-reported error can be matched to the gateway and upstream logs.
import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, Response } from 'express';

const VALID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The inbound `x-request-id` when it is well-formed, otherwise a fresh `req_<uuid>`. */
export function requestIdOf(req: { headers: IncomingHttpHeaders }): string {
  const h = req.headers['x-request-id'];
  const v = Array.isArray(h) ? h[0] : h;
  return typeof v === 'string' && VALID.test(v) ? v : `req_${crypto.randomUUID()}`;
}

/** The id attached to this request by `requestIds()` (falls back to reading the header). */
export const requestId = (req: Request): string => ((req as any).requestId as string | undefined) ?? requestIdOf(req);

/**
 * Express middleware: fixes the request id (header or generated), sets it as `X-Request-Id` on the
 * response and on `req.headers` (so sub-mounted apps see the same id), and adds `requestId` to every
 * JSON body sent with a 4xx/5xx status.
 */
export function requestIds() {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = requestId(req);
    (req as any).requestId = id;
    req.headers['x-request-id'] = id;
    res.setHeader('X-Request-Id', id);
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body) && !('requestId' in body)) body = { ...body, requestId: id };
      return json(body);
    }) as Response['json'];
    next();
  };
}
