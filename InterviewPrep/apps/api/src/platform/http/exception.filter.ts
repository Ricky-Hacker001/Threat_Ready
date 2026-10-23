import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { DomainError, ERROR_CATALOGUE, PortError, type ErrorEnvelope } from '@threatready/shared';
import type { Response } from 'express';
import { logger, requestContext } from '../logging/logger.js';

/**
 * Global filter (ADD §10): builds the envelope, logs the cause with the request_id, and reports a
 * scrubbed event to Sentry. Stack traces, SQL, provider messages and secrets are never exposed.
 */
@Catch()
export class EnvelopeExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = requestContext.getStore()?.requestId ?? 'req_unknown';
    const envelope = toEnvelope(exception, requestId);
    const bodyParser = bodyParserStatus(exception);
    const status = bodyParser ?? (envelope.error.code === 'INTERNAL_ERROR' && exception instanceof HttpException ? exception.getStatus() : ERROR_CATALOGUE[envelope.error.code].http);

    if (status >= 500) {
      logger.error({ code: envelope.error.code, err: errInfo(exception) }, 'request failed');
      Sentry.captureException(exception, { tags: { code: envelope.error.code }, extra: { request_id: requestId } });
    } else {
      logger.info({ code: envelope.error.code, status }, 'request rejected');
    }
    if (res.headersSent) {
      // A streaming response already started; the SSE layer reports the error in-band.
      res.end();
      return;
    }
    res.status(status).json(envelope);
  }
}

/**
 * express.json() rejections (malformed JSON, body over the 64 KB limit) arrive as plain errors with a
 * body-parser `type`. They are client errors: 400 / 413 envelopes, never 500s or Sentry events.
 */
function bodyParserType(exception: unknown): string | null {
  const e = exception as { type?: unknown; status?: unknown; statusCode?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : 0;
  return typeof e?.type === 'string' && /^(entity|charset|encoding|parameters|request)\./.test(e.type) && status >= 400 && status < 500 ? e.type : null;
}

function bodyParserStatus(exception: unknown): number | null {
  const type = bodyParserType(exception);
  if (!type) return null;
  return type === 'entity.too.large' ? 413 : 400;
}

export function toEnvelope(exception: unknown, requestId: string): ErrorEnvelope {
  const parser = bodyParserType(exception);
  if (parser === 'entity.too.large') {
    return { error: { code: 'RESUME_TOO_LARGE', message: 'The request body is too large', request_id: requestId, retryable: false } };
  }
  if (parser) {
    return { error: { code: 'VALIDATION_FAILED', message: 'The request body could not be read as JSON', request_id: requestId, retryable: false } };
  }
  if (exception instanceof DomainError) {
    return { error: { code: exception.code, message: exception.message, request_id: requestId, retryable: exception.retryable, details: exception.details } };
  }
  if (exception instanceof PortError) {
    const code = exception.retryable ? 'INTERNAL_ERROR' : 'INTERNAL_ERROR';
    return { error: { code, message: ERROR_CATALOGUE[code].message, request_id: requestId, retryable: exception.retryable } };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = status === 404 ? 'INTERVIEW_SESSION_NOT_FOUND' : status === 413 ? 'RESUME_TOO_LARGE' : status === 400 || status === 422 ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR';
    const message = status === 404 ? 'Not found' : ERROR_CATALOGUE[code].message;
    return { error: { code, message, request_id: requestId, retryable: ERROR_CATALOGUE[code].retryable } };
  }
  return { error: { code: 'INTERNAL_ERROR', message: ERROR_CATALOGUE.INTERNAL_ERROR.message, request_id: requestId, retryable: true } };
}

function errInfo(e: unknown) {
  if (e instanceof Error) return { name: e.name, message: e.message, cause: (e.cause as Error | undefined)?.name, stack: e.stack };
  return { value: String(e) };
}
