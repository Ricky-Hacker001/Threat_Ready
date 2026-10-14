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
    const status = envelope.error.code === 'INTERNAL_ERROR' && exception instanceof HttpException ? exception.getStatus() : ERROR_CATALOGUE[envelope.error.code].http;

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

export function toEnvelope(exception: unknown, requestId: string): ErrorEnvelope {
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
