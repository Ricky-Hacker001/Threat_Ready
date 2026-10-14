import { describe, expect, it } from 'vitest';
import { visemeAt, wordDuration, wordToVisemes } from '../src/features/interview-prep/avatar/visemes';

describe('text-driven lip sync', () => {
  it('maps spelling to plausible viseme sequences', () => {
    expect(wordToVisemes('phishing')).toEqual(['FF', 'I', 'CH', 'I', 'nn']);
    expect(wordToVisemes('Tell')).toEqual(['DD', 'E', 'nn']);
    expect(wordToVisemes('me,')).toEqual(['PP', 'E']);
    expect(wordToVisemes('about')).toEqual(['aa', 'PP', 'aa', 'U', 'DD']);
    expect(wordToVisemes('—')).toEqual([]);
  });
  it('spreads a word over its duration and is silent outside it', () => {
    const seq = wordToVisemes('map');
    const d = wordDuration('map');
    expect(visemeAt(seq, d, 0)).toBe('PP');
    expect(visemeAt(seq, d, d / 2)).toBe('aa');
    expect(visemeAt(seq, d, d * 0.99)).toBe('PP');
    expect(visemeAt(seq, d, d + 0.01)).toBeNull();
    expect(wordDuration('map', 2)).toBeLessThan(wordDuration('map', 1));
  });
});
