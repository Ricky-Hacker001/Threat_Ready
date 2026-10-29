import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { reportError } from "./error-report.js";

/** 429 from a limit enforced in code (not the throttler guard): carries when to retry. */
export class TooManyRequestsException extends HttpException {
  constructor(
    readonly retryAfter: number,
    message = "Too many requests. Try again later.",
    code = "RATE_LIMITED",
  ) {
    super({ code, message }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * One error shape for the SPA: { statusCode, code, message }, plus retryAfter (seconds, also sent as
 * Retry-After) on every 429 so clients can say when to try again. Never leaks internals.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Http");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ThrottlerException) {
      // The throttler guard has already set Retry-After (seconds until the block ends).
      const retryAfter = Math.max(1, Number(res.getHeader("Retry-After")) || 60);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ statusCode: 429, code: "RATE_LIMITED", message: "Too many requests. Try again shortly.", retryAfter });
      return;
    }
    if (exception instanceof TooManyRequestsException) {
      const retryAfter = Math.max(1, Math.ceil(exception.retryAfter));
      const body = exception.getResponse() as { code: string; message: string };
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ statusCode: 429, code: body.code, message: body.message, retryAfter });
      return;
    }
    // body-parser (express.json) errors are plain Errors with a `type`: a bad body is the client's 400/413, not our 500.
    const bodyError = bodyParserStatus(exception);
    if (bodyError) {
      res.status(bodyError.status).json({ statusCode: bodyError.status, code: bodyError.code, message: bodyError.message });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const obj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const code = typeof obj.code === "string" ? obj.code : HttpStatus[status] ?? "ERROR";
      const message =
        typeof obj.message === "string" ? obj.message : typeof body === "string" ? body : "Request failed";
      res.status(status).json({ statusCode: status, code, message });
      return;
    }
    this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    // The route pattern only (e.g. GET /api/admin/users/:id): no ids, query string or request data.
    const req = host.switchToHttp().getRequest<Request>();
    void reportError(exception, `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? "(no route)"}`);
    res.status(500).json({ statusCode: 500, code: "INTERNAL", message: "Something went wrong" });
  }
}

const BODY_PARSER_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  "entity.parse.failed": { status: 400, code: "VALIDATION_FAILED", message: "The request body is not valid JSON." },
  "entity.too.large": { status: 413, code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." },
  "entity.verify.failed": { status: 403, code: "FORBIDDEN", message: "Forbidden" },
  "request.aborted": { status: 400, code: "VALIDATION_FAILED", message: "The request ended before the body arrived." },
  "encoding.unsupported": { status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Unsupported content encoding." },
  "charset.unsupported": { status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Unsupported charset." },
  "parameters.too.many": { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Too many parameters." },
};

/** The response for a body-parser error, or null when `err` is something else. */
export function bodyParserStatus(err: unknown): { status: number; code: string; message: string } | null {
  if (!(err instanceof Error)) return null;
  const type = (err as { type?: unknown }).type;
  return typeof type === "string" ? (BODY_PARSER_ERRORS[type] ?? null) : null;
}
