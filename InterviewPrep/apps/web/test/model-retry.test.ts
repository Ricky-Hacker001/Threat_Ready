import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadInterviewerModel, resetInterviewerModel, RETRY_AFTER_MS } from '../src/features/interview-prep/avatar/loadModel';

/** A missing model must not turn into a request loop (seen on Render: ~6 requests a second). */
describe('interviewer model loading after a failure', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    resetInterviewerModel();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks once for a model the server does not have (404), however often it is requested', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    for (let i = 0; i < 20; i++) await expect(loadInterviewerModel()).rejects.toThrow('404');
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS * 3);
    await expect(loadInterviewerModel()).rejects.toThrow('404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure, but only after the cool-down', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(loadInterviewerModel()).rejects.toThrow('503');
    await expect(loadInterviewerModel()).rejects.toThrow('503');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_MS + 1);
    await expect(loadInterviewerModel()).rejects.toThrow('503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
