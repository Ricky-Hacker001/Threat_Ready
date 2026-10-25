import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, messageFor, retryAfterMs, uploadToStorage, whenRetry } from '../src/lib/api';

/** An API error envelope, optionally with a Retry-After header. */
const envelope = (code: string, status: number, retryAfter?: string, retryable = true) =>
  new Response(JSON.stringify({ error: { code, message: 'server message', request_id: 'req_abc123def456', retryable } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...(retryAfter ? { 'Retry-After': retryAfter } : {}) },
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Retry-After (TR-52): long limits are reported, never retried early', () => {
  it('does not retry a 429 that asks for an hour, and says when to try again', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => envelope('RATE_LIMITED', 429, '3600'));
    const before = Date.now();
    const err = (await api.dashboard().catch((e: unknown) => e)) as ApiError;
    expect(f).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAt).toBeGreaterThanOrEqual(before + 3600_000);
    const msg = messageFor(err);
    expect(msg).toMatch(/You can try again (at|on) /);
    expect(msg).not.toMatch(/moment|RATE_LIMITED|429/);
  });

  it('waits the whole of a short Retry-After before the one retry', async () => {
    vi.useFakeTimers();
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(envelope('RATE_LIMITED', 429, '8'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const p = api.dashboard();
    await vi.advanceTimersByTimeAsync(7_900);
    expect(f).toHaveBeenCalledTimes(1); // the old client retried after min(Retry-After, 5 s): too early
    await vi.advanceTimersByTimeAsync(400);
    expect(f).toHaveBeenCalledTimes(2);
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('a 503 with Retry-After keeps the catalogue message and adds when to try again', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => envelope('LLM_PROVIDER_UNAVAILABLE', 503, '120'));
    const err = await api.dashboard().catch((e: unknown) => e);
    expect(messageFor(err)).toBe('The AI service is temporarily unavailable. Your progress is saved. Try again in about 2 minutes.');
  });

  it('a 429 from a proxy without the envelope is still a rate limit with a human message', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '900' } }));
    const err = (await api.dashboard().catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('RATE_LIMITED');
    expect(messageFor(err)).toMatch(/^You have reached the limit for this for now\. You can try again in about 15 minutes\.$/);
  });

  it('reads Retry-After as seconds or as an HTTP date', () => {
    const now = Date.parse('2026-10-23T10:00:00Z');
    expect(retryAfterMs('30', now)).toBe(30_000);
    expect(retryAfterMs('Fri, 23 Oct 2026 10:05:00 GMT', now)).toBe(300_000);
    expect(retryAfterMs('soon', now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
    // A fraction is read as seconds (rounded up), never as a date: Date.parse('5.5') is a day in 2001.
    expect(retryAfterMs('5.5', now)).toBe(6_000);
    expect(retryAfterMs('-5', now)).toBeNull();
    // An absurd wait is capped at a week, so the message never prints a nonsense date.
    expect(retryAfterMs('99999999999', now)).toBe(7 * 24 * 3600_000);
    expect(whenRetry(now + 1e15, now)).toMatch(/^on .+ at \S/);
    expect(whenRetry(Number.NaN, now)).toBe('later');
    expect(messageFor(new ApiError('RATE_LIMITED', 'x', 429, false, null, undefined, Number.NaN))).not.toMatch(/Invalid Date|NaN/);
  });

  it('phrases the wait for people', () => {
    const now = new Date(2026, 9, 23, 10, 0, 0).getTime();
    expect(whenRetry(now + 1_000, now)).toBe('in a moment');
    expect(whenRetry(now + 40_000, now)).toBe('in 40 seconds');
    expect(whenRetry(now + 12 * 60_000, now)).toBe('in about 12 minutes');
    expect(whenRetry(now + 3 * 3600_000, now)).toMatch(/^at \S/);
    expect(whenRetry(new Date(2026, 9, 24, 9, 0).getTime(), now)).toMatch(/^on .+ at \S/);
  });
});

describe("the platform gateway's own answers (deploy/gateway.mjs)", () => {
  const gateway = (status: number, code: string, message: string) =>
    new Response(JSON.stringify({ error: { code, message, retryable: status >= 500 } }), { status, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } });
  const cases: [number, string, string][] = [
    [503, 'STARTING', 'ThreatReady is starting up. Try again in a few seconds.'],
    [502, 'UPSTREAM_UNAVAILABLE', 'This part of ThreatReady is restarting. Try again shortly.'],
    [504, 'UPSTREAM_TIMEOUT', 'ThreatReady took too long to answer. Try again in a moment.'],
  ];

  it.each(cases)('%i %s says once when to try again, never "Try again … Try again …"', async (status, code, message) => {
    vi.useFakeTimers();
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => gateway(status, code, message));
    const p = api.dashboard().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(12_000); // two honoured 5 s waits, then the error
    const err = (await p) as ApiError;
    expect(f).toHaveBeenCalledTimes(3);
    expect(err.code).toBe(code);
    const msg = messageFor(err);
    expect(msg.match(/try again/gi)).toHaveLength(1);
    expect(msg).toMatch(/^InterviewPrep .+\. Try again in (\d seconds|a moment)\.$/);
  });

  it('a message that already ends with its own "Try again" gets the time instead of a second one', () => {
    const retryAt = Date.now() + 40_000;
    expect(messageFor(new ApiError('SOMETHING_NEW', 'Busy right now. Try again shortly.', 503, true, null, undefined, retryAt))).toBe('Busy right now. Try again in 40 seconds.');
    expect(messageFor(new ApiError('PARSE_FAILED', 'x', 503, true, null, undefined, retryAt))).toBe('We could not analyse these documents. Check the extracted text and try again in 40 seconds.');
  });

  it('a gateway timeout on a write is not sent again (it may have been applied)', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => gateway(504, 'UPSTREAM_TIMEOUT', 'ThreatReady took too long to answer. Try again in a moment.'));
    const err = (await api.createSession('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('UPSTREAM_TIMEOUT');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('storage upload errors (TR-52)', () => {
  class FakeXHR {
    static status = 429;
    static headers: Record<string, string> = { 'retry-after': '600' };
    status = 0;
    responseText = '';
    withCredentials = false;
    upload = { onprogress: null as unknown };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    open() {}
    send() {
      this.status = FakeXHR.status;
      setTimeout(() => this.onload?.(), 0);
    }
    getResponseHeader(name: string) {
      return FakeXHR.headers[name.toLowerCase()] ?? null;
    }
  }
  const upload = { url: '/v1/dev-storage/upload', fields: { key: 'k' }, expiresAt: new Date().toISOString(), maxBytes: 5_000_000 };

  it('maps an upload 429 to RATE_LIMITED with when to try again (not "Upload failed")', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    const err = (await uploadToStorage(upload, new File(['%PDF'], 'cv.pdf'), () => {}).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAt).toBeGreaterThan(Date.now() + 590_000);
    expect(messageFor(err)).toBe('You have reached the limit for this for now. You can try again in about 10 minutes.');
  });

  it('keeps an expired upload policy (403) as STORAGE_UPLOAD_EXPIRED and storage trouble as a readable message', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    FakeXHR.status = 403;
    await expect(uploadToStorage(upload, new File(['x'], 'cv.pdf'), () => {})).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_EXPIRED' });
    FakeXHR.status = 500;
    const err = await uploadToStorage(upload, new File(['x'], 'cv.pdf'), () => {}).catch((e: unknown) => e);
    expect(messageFor(err)).not.toBe('Upload failed');
    FakeXHR.status = 429;
  });
});

describe('client copy and new endpoints', () => {
  it('the report retry cap gets its own message, never the open-interview one (UX-REG4)', () => {
    const msg = messageFor(new ApiError('REPORT_RETRY_LIMIT_REACHED', 'x', 409, false, 'req_1'));
    expect(msg).toMatch(/could not generate this report/);
    expect(msg).not.toMatch(/open interview/);
  });

  it('deleteDocument sends DELETE /v1/documents/:id (TR-13)', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.deleteDocument('11111111-1111-4111-8111-111111111111')).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledWith('/v1/documents/11111111-1111-4111-8111-111111111111', expect.objectContaining({ method: 'DELETE', credentials: 'include' }));
  });

  it('a network failure reads as a connection problem, not "Network error"', () => {
    expect(messageFor(new ApiError('NETWORK_ERROR', 'Network error', 0, true, null))).toMatch(/could not reach ThreatReady/);
  });
});
