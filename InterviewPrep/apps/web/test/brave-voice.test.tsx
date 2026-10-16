import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Brave: `navigator.brave` exists only there. It must be in place before the hook module loads.
async function loadVoiceAs(brave: boolean) {
  vi.resetModules();
  if (brave) Object.defineProperty(navigator, 'brave', { configurable: true, value: { isBrave: () => Promise.resolve(true) } });
  else delete (navigator as any).brave;
  return import('../src/features/interview-prep/hooks/useVoice');
}

class FakeRecognition { continuous = false; interimResults = false; lang = ''; maxAlternatives = 1; onresult = null; onerror = null; onend = null; start() {} stop() {} abort() {} }

afterEach(() => {
  delete (navigator as any).brave;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('voice in Brave', () => {
  it('reports speech recognition unsupported even though Brave exposes the API', async () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const chrome = await loadVoiceAs(false);
    expect(chrome.isBrave).toBe(false);
    expect(renderHook(() => chrome.useSpeechRecognition()).result.current.supported).toBe(true);

    const brave = await loadVoiceAs(true);
    expect(brave.isBrave).toBe(true);
    expect(renderHook(() => brave.useSpeechRecognition()).result.current.supported).toBe(false);
  });

  it('carries on when speech synthesis accepts an utterance but never starts it', async () => {
    vi.useFakeTimers();
    const synth = { cancel: vi.fn(), speak: vi.fn(), getVoices: () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class { text: string; constructor(t: string) { this.text = t; } } });
    const { useSpeech } = await loadVoiceAs(false);
    const { result, unmount } = renderHook(() => useSpeech(true));
    expect(result.current.supported).toBe(true);
    const onEnd = vi.fn();
    act(() => result.current.speak('Tell me about a time you triaged an alert.', onEnd));
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(result.current.speaking).toBe(true);
    expect(onEnd).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(3100); });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(result.current.speaking).toBe(false);
    unmount();
    delete (window as any).speechSynthesis;
    delete (window as any).SpeechSynthesisUtterance;
  });
});
