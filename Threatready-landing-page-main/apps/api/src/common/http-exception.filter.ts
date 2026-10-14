import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import type { Response } from "express";

/** One error shape for the SPA: { statusCode, code, message }. Never leaks internals. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Http");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ThrottlerException) {
      res.status(429).json({ statusCode: 429, code: "RATE_LIMITED", message: "Too many requests. Try again shortly." });
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
    res.status(500).json({ statusCode: 500, code: "INTERNAL", message: "Something went wrong" });
  }
}
