import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarFallback } from '../src/features/interview-prep/avatar/AvatarFallback';
import { frameKey, mouthIndex, resetPhotoSet } from '../src/features/interview-prep/avatar/InterviewerPhoto';
import { speechBus } from '../src/features/interview-prep/avatar/speechBus';

const MANIFEST = { version: 1, width: 600, height: 800, yaws: 3, mouths: 5, blinks: 2, smile: true };

/** jsdom has no canvas: a 2D context that records what was drawn. */
function fakeCanvas() {
  const drawn: string[] = [];
  const ctx = { clearRect: vi.fn(), drawImage: vi.fn((img: HTMLImageElement) => drawn.push(img.src.split('/').pop()!.replace('.webp', ''))) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return drawn;
}
/** Every still "loads" as soon as its src is set. */
function fakeImages() {
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    set(this: HTMLImageElement, v: string) { this.setAttribute('src', v); queueMicrotask(() => this.onload?.(new Event('load'))); },
    get(this: HTMLImageElement) { return this.getAttribute('src') ?? ''; },
  });
}

beforeEach(() => resetPhotoSet());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('mouth stills', () => {
  it('maps a 0..1 level to the nearest photographed mouth', () => {
    expect(mouthIndex(0, 5)).toBe(0);
    expect(mouthIndex(0.12, 5)).toBe(0);
    expect(mouthIndex(0.3, 5)).toBe(1);
    expect(mouthIndex(0.62, 5)).toBe(2);
    expect(mouthIndex(1, 5)).toBe(4);
    expect(frameKey(1, 3, 0)).toBe('y1_m3_b0');
  });
});

describe('2D interviewer', () => {
  it('falls back to the illustrated portrait when the photos are not deployed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    render(<AvatarFallback status="listening" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('img', { name: /alex, your interviewer/i }).tagName).toBe('svg');
    expect(screen.queryByTestId('interviewer-photo')).not.toBeInTheDocument();
  });

  it('shows the photographs with lip sync and blinks when they are deployed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(MANIFEST)));
    fakeImages();
    const drawn = fakeCanvas();
    const rafs: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { rafs.push(cb); return rafs.length; });
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const tick = (ms: number) => { now += ms; const cb = rafs.pop()!; rafs.length = 0; act(() => cb(now)); };

    const { rerender } = render(<AvatarFallback status="asking" speaking={false} />);
    const canvas = await screen.findByTestId('interviewer-photo');
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas).toHaveAttribute('aria-label', 'Alex, your interviewer');
    expect(screen.queryByRole('img', { name: /alex/i })?.tagName).toBe('CANVAS');

    // Rest: the straight-ahead, mouth-closed, eyes-open still.
    tick(16);
    expect(drawn.at(-1)).toBe('y1_m0_b0');

    // Speaking "ah": the word's visemes open the mouth over its length.
    rerender(<AvatarFallback status="asking" speaking />);
    act(() => speechBus.emit({ word: 'awesome', at: now, rate: 1 }));
    const before = drawn.length;
    for (let i = 0; i < 8; i++) tick(30);
    const mouths = drawn.slice(before).map((k) => Number(/_m(\d)/.exec(k)?.[1]));
    expect(Math.max(...mouths)).toBeGreaterThan(0);

    // A blink shows the eyes-closed still of the same pose, then returns.
    rerender(<AvatarFallback status="listening" speaking={false} />);
    act(() => speechBus.emit(null));
    for (let i = 0; i < 300 && !drawn.at(-1)?.endsWith('_b1'); i++) tick(25);
    expect(drawn.at(-1)).toMatch(/_b1$/);
    for (let i = 0; i < 20; i++) tick(25);
    expect(drawn.at(-1)).toMatch(/_b0$/);
  });
});
