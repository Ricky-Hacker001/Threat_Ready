import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterviewerPortrait } from '../src/features/interview-prep/avatar/InterviewerPortrait';
import { speechBus } from '../src/features/interview-prep/avatar/speechBus';

/** The 2D interviewer's mouth must move while speaking, with or without word events. */
describe('2D interviewer lip sync', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }));
  afterEach(() => vi.useRealTimers());

  const lipsOf = (svg: Element) => svg.querySelector('.ivw-p-lips')!.getAttribute('d');
  const openingOf = (svg: Element) => svg.querySelector('.ivw-p-mouth-in')!.getAttribute('d') ?? '';
  const frames = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  it('keeps the mouth closed when not speaking', () => {
    render(<InterviewerPortrait status="listening" speaking={false} />);
    const svg = screen.getByRole('img', { name: /alex/i });
    frames(500);
    expect(openingOf(svg)).toBe('');
  });

  it('opens and shapes the mouth from word timing', () => {
    render(<InterviewerPortrait status="asking" speaking />);
    const svg = screen.getByRole('img', { name: /alex/i });
    const closed = lipsOf(svg);
    act(() => speechBus.emit({ word: 'about', at: performance.now(), rate: 1 }));
    frames(80);
    expect(openingOf(svg)).not.toBe('');
    expect(lipsOf(svg)).not.toBe(closed);
  });

  it('still moves when the browser sends no word events (e.g. Chrome network voices)', () => {
    render(<InterviewerPortrait status="asking" speaking />);
    const svg = screen.getByRole('img', { name: /alex/i });
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      frames(60);
      seen.add(lipsOf(svg)!);
    }
    expect(seen.size).toBeGreaterThan(3);
  });
});
