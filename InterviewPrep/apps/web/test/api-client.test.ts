import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, messageFor, streamTurn } from '../src/lib/api';
import { validateFile } from '../src/features/interview-prep/components/DocumentStep';

const envelope = (code: string, retryable: boolean, status: number) =>
  new Response(JSON.stringify({ error: { code, message: 'server message', request_id: 'req_abc123def456', retryable } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => vi.restoreAllMocks());

describe('API client error handling (ADD §10 frontend contract)', () => {
  it('maps the envelope to ApiError with a catalogue message and request id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope('INTERVIEW_SESSION_NOT_FOUND', false, 404));
    const err = await api.session('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'INTERVIEW_SESSION_NOT_FOUND', status: 404, retryable: false, requestId: 'req_abc123def456' });
  });

  it('retries only retryable failures, up to three attempts', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => envelope('LLM_PROVIDER_UNAVAILABLE', true, 503));
    await expect(api.dashboard()).rejects.toMatchObject({ code: 'LLM_PROVIDER_UNAVAILABLE' });
    expect(f).toHaveBeenCalledTimes(3);
    f.mockClear();
    f.mockImplementation(async () => envelope('VALIDATION_FAILED', false, 422));
    await expect(api.dashboard()).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(f).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('never auto-retries a turn already in progress', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => envelope('INTERVIEW_TURN_IN_PROGRESS', true, 409));
    await expect(api.pause('x')).rejects.toMatchObject({ code: 'INTERVIEW_TURN_IN_PROGRESS' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('uses friendly catalogue messages', () => {
    expect(messageFor(new ApiError('LLM_BUDGET_EXCEEDED', 'x', 429, false, null))).toMatch(/usage limit/);
    expect(messageFor(new Error('boom'))).toMatch(/Something went wrong/);
  });
});

describe('turn stream parsing', () => {
  function sseResponse(chunks: string[]) {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  it('parses events split across chunks and ignores heartbeats', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([': heartbeat\n\n', 'id: 1\nevent: question.delta\ndata: {"type":"question.del', 'ta","text":"Hello"}\n\n', 'id: 2\nevent: done\ndata: {"type":"done","session":{"id":"s"}}\n\n']),
    );
    const events: string[] = [];
    await streamTurn('/v1/interviews/s/turns', {}, (e) => events.push(e.type));
    expect(events).toEqual(['question.delta', 'done']);
  });

  it('reports an interrupted stream as retryable so the room can recover', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(['id: 1\nevent: evaluating\ndata: {"type":"evaluating"}\n\n']));
    await expect(streamTurn('/x', {}, () => undefined)).rejects.toMatchObject({ code: 'STREAM_INTERRUPTED', retryable: true });
  });

  it('turns a pre-stream rejection into an ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope('INTERVIEW_INVALID_STATE', false, 409));
    await expect(streamTurn('/x', {}, () => undefined)).rejects.toMatchObject({ code: 'INTERVIEW_INVALID_STATE', status: 409 });
  });
});

describe('client-side upload validation', () => {
  const file = (name: string, size: number) => new File([new Uint8Array(size)], name);
  it('accepts PDF and DOCX up to 5 MB', () => {
    expect(validateFile(file('cv.pdf', 1000))).toBeNull();
    expect(validateFile(file('cv.DOCX', 1000))).toBeNull();
  });
  it('rejects other types, empty and oversize files', () => {
    expect(validateFile(file('cv.png', 1000))).toMatch(/PDF or DOCX/);
    expect(validateFile(file('cv.pdf', 0))).toMatch(/empty/);
    expect(validateFile(file('cv.pdf', 6 * 1024 * 1024))).toMatch(/5 MB/);
  });
});
