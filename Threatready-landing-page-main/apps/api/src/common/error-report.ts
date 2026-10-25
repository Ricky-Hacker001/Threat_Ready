import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";

/*
 * Server errors to Sentry without its SDK (no extra dependency): one event per error, posted to the
 * project's envelope endpoint. Off unless SENTRY_DSN is set (TR-14). A report never throws and never
 * delays a response. It carries the error type, message and stack and the route pattern (method and
 * path pattern; no query string, headers, cookies or body), so no request data leaves the server.
 * One event per distinct error and route a minute, and at most MAX_EVENTS every ten minutes, so an
 * error loop cannot flood the project or the network.
 */

const MAX_EVENTS = 30;
const BUDGET_WINDOW_MS = 10 * 60_000;
const REPEAT_WINDOW_MS = 60_000;
const SEND_TIMEOUT_MS = 5_000;

export interface ErrorReportOptions {
  dsn?: string;
  environment: string;
  release?: string;
}

interface Target {
  url: string;
  auth: string;
  dsn: string;
}

type Send = (url: string, init: RequestInit) => Promise<unknown>;

/** https://<key>@<host>[/<prefix>]/<project> -> the envelope endpoint and its auth header, or null. */
export function parseDsn(dsn: string): Target | null {
  try {
    const u = new URL(dsn);
    const parts = u.pathname.split("/").filter(Boolean);
    const project = parts.pop();
    if (!/^https?:$/.test(u.protocol) || !u.username || !project || !/^\d+$/.test(project)) return null;
    const prefix = parts.length ? `/${parts.join("/")}` : "";
    return {
      url: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`,
      auth: `Sentry sentry_version=7, sentry_key=${u.username}, sentry_client=threatready-onboard/1.0`,
      dsn,
    };
  } catch {
    return null;
  }
}

const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/** V8 stack lines as Sentry frames, oldest call first. */
function stacktrace(stack: string | undefined) {
  const frames = [];
  for (const line of (stack ?? "").split("\n").slice(1)) {
    const m = FRAME.exec(line);
    if (!m) continue;
    const filename = m[2] ?? "?";
    frames.push({
      function: m[1] ?? "?",
      filename,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !filename.includes("node_modules") && !filename.startsWith("node:"),
    });
  }
  return frames.length ? { frames: frames.reverse() } : undefined;
}

export class ErrorReporter {
  private readonly recent = new Map<string, number>();
  private budget = { start: 0, used: 0 };
  private warnedAt = 0;

  constructor(
    private readonly target: Target | null,
    private readonly meta: { environment: string; release?: string },
    private readonly send: Send = (url, init) => fetch(url, init),
    private readonly logger = new Logger("ErrorReport"),
  ) {}

  get enabled(): boolean {
    return this.target !== null;
  }

  /** Sends one event unless reports are off or over budget. Resolves when sent (or given up); never rejects. */
  async report(err: unknown, route = "", now = Date.now()): Promise<void> {
    if (!this.target) return;
    const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Non-error value thrown");
    const fingerprint = `${e.name}:${e.message}:${route}`;
    if (now - (this.recent.get(fingerprint) ?? -Infinity) < REPEAT_WINDOW_MS) return;
    if (now - this.budget.start >= BUDGET_WINDOW_MS) this.budget = { start: now, used: 0 };
    if (this.budget.used >= MAX_EVENTS) return;
    this.budget.used += 1;
    if (this.recent.size > 500) this.recent.clear();
    this.recent.set(fingerprint, now);

    const id = randomUUID().replace(/-/g, "");
    const event = {
      event_id: id,
      timestamp: now / 1000,
      platform: "node",
      level: "error",
      logger: "onboard",
      server_name: "onboard",
      environment: this.meta.environment,
      ...(this.meta.release ? { release: this.meta.release } : {}),
      ...(route ? { transaction: route, tags: { route } } : {}),
      exception: { values: [{ type: e.name || "Error", value: e.message.slice(0, 2000), stacktrace: stacktrace(e.stack) }] },
    };
    const body = [JSON.stringify({ event_id: id, sent_at: new Date(now).toISOString(), dsn: this.target.dsn }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
    try {
      await this.send(this.target.url, {
        method: "POST",
        headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": this.target.auth },
        body: `${body}\n`,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (sendErr) {
      // At most one warning every ten minutes: an unreachable Sentry must not flood the logs either.
      if (now - this.warnedAt >= BUDGET_WINDOW_MS) {
        this.warnedAt = now;
        this.logger.warn(`could not send an error report: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
      }
    }
  }
}

let reporter: ErrorReporter | null = null;

/** Called once at boot. A malformed DSN turns reports off with a warning; it never stops the API. */
export function initErrorReports(options: ErrorReportOptions, send?: Send): ErrorReporter {
  const logger = new Logger("ErrorReport");
  const target = options.dsn ? parseDsn(options.dsn) : null;
  if (options.dsn && !target) logger.warn("SENTRY_DSN is not a valid Sentry DSN; error reports are off");
  reporter = new ErrorReporter(target, { environment: options.environment, release: options.release }, send, logger);
  return reporter;
}

/** Fire and forget, from wherever a server error is handled. A no-op until initErrorReports. */
export function reportError(err: unknown, route?: string): Promise<void> {
  return reporter ? reporter.report(err, route) : Promise.resolve();
}
