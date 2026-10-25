import type { TurnStreamEvent } from '@threatready/contracts';
import { DomainError, ERROR_CATALOGUE } from '@threatready/shared';
import type { Response } from 'express';
import { logger, requestContext } from '../logging/logger.js';
import { retryAfterOf } from './exception.filter.js';

/**
 * Server-Sent Events writer. Heartbeat comments every 20 s keep the stream under the ALB idle
 * timeout and Cloudflare's 125 s (ADD §3 coupling check). Every stream ends with done or error.
 */
export class SseStream {
  private heartbeat: NodeJS.Timeout | null = null;
  private seq = 0;
  private closed = false;
  private opened = false;

  /**
   * Headers are sent with the first event, so a request rejected before any work starts
   * (wrong state, turn in progress) still gets a normal HTTP status and error envelope.
   */
  constructor(private readonly res: Response) {
    res.on('close', () => {
      this.closed = true;
      if (this.heartbeat) clearInterval(this.heartbeat);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get started(): boolean {
    return this.opened;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.res.status(200);
    this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    this.res.setHeader('Cache-Control', 'no-cache, no-transform');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('X-Accel-Buffering', 'no');
    this.res.flushHeaders();
    this.heartbeat = setInterval(() => this.write(': heartbeat\n\n'), 20_000);
  }

  send(event: TurnStreamEvent | { type: string; [k: string]: unknown }): void {
    this.seq += 1;
    this.write(`id: ${this.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  error(err: unknown): void {
    const requestId = requestContext.getStore()?.requestId ?? 'req_unknown';
    if (err instanceof DomainError) {
      const retryAfter = retryAfterOf(err, err.code);
      this.send({ type: 'error', code: err.code, message: err.message, retryable: err.retryable, request_id: requestId, ...(retryAfter ? { retry_after_sec: retryAfter } : {}) });
    } else {
      logger.error({ err: { name: (err as Error)?.name, message: (err as Error)?.message, stack: (err as Error)?.stack } }, 'stream failed');
      this.send({ type: 'error', code: 'INTERNAL_ERROR', message: ERROR_CATALOGUE.INTERNAL_ERROR.message, retryable: true, request_id: requestId });
    }
  }

  end(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (!this.closed) this.res.end();
    this.closed = true;
  }

  private write(chunk: string): void {
    if (this.closed) return;
    this.open();
    this.res.write(chunk);
  }
}

/** Open event streams a user may hold at once; the next one is refused with 429 (RATE_LIMITED). */
export const MAX_SSE_STREAMS_PER_USER = 3;
/** How often a long-lived stream re-checks that its session is still valid. */
export const SSE_IDENTITY_RECHECK_MS = 30_000;

/**
 * State-stream timing: the first database poll after 2 s, then backing off by half up to 10 s, so a
 * long analysis or report costs a few queries a minute per stream, not thirty. Mutable for tests.
 */
export const SSE_TIMING = { firstPollMs: 2_000, maxPollMs: 10_000, identityRecheckMs: SSE_IDENTITY_RECHECK_MS };

const openStreams = new Map<string, number>();

/**
 * Reserves one of the user's stream slots. Returns the release function; call it when the stream
 * ends (the `close` event or the loop's exit). Without this, one session could hold any number of
 * five-minute server loops open.
 */
export function acquireStreamSlot(userId: string, max = MAX_SSE_STREAMS_PER_USER): () => void {
  const open = openStreams.get(userId) ?? 0;
  if (open >= max) throw new DomainError('RATE_LIMITED', { message: 'Too many open event streams; close one and retry', retryAfterSec: 10, details: { scope: 'event_streams', retryAfterSec: 10 } });
  openStreams.set(userId, open + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (openStreams.get(userId) ?? 1) - 1;
    if (n <= 0) openStreams.delete(userId);
    else openStreams.set(userId, n);
  };
}
