import { useCallback, useEffect, useRef, useState } from 'react';
import { speechBus } from '../avatar/speechBus';

/**
 * Voice for the interview room, using only browser APIs (no paid voice service, no change to the
 * interview engine): speech synthesis speaks Alex's questions, speech recognition turns the
 * candidate's speech into the same text answer the API already accepts (ADD L14 voice note).
 */

// ---------- Speech synthesis (Alex speaking) ----------

/** Prefer natural, neural voices and a male voice to match the avatar; fall back to any English voice. */
function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const english = voices.filter((v) => /^en[-_]/i.test(v.lang));
  const score = (v: SpeechSynthesisVoice) =>
    (/natural|neural|online|premium|enhanced/i.test(v.name) ? 8 : 0) +
    (/male|guy|ryan|daniel|david|george|arthur|aaron|google uk english male|rishi|prabhat/i.test(v.name) && !/female/i.test(v.name) ? 4 : 0) +
    (/en[-_](IN|GB)/i.test(v.lang) ? 2 : /en[-_]US/i.test(v.lang) ? 1 : 0) +
    (v.localService ? 0 : 1);
  return [...english].sort((a, b) => score(b) - score(a))[0] ?? voices[0];
}

/** Chrome stops long utterances after ~15 s, so speech is queued sentence by sentence. */
const sentences = (text: string) => text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];

export function useSpeech(enabled: boolean) {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const voice = useRef<SpeechSynthesisVoice | undefined>(undefined);
  const decay = useRef<number | null>(null);
  const token = useRef(0);

  useEffect(() => {
    if (!supported) return;
    const load = () => (voice.current = pickVoice(window.speechSynthesis.getVoices()));
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, [supported]);

  const stop = useCallback(() => {
    token.current += 1;
    if (supported) window.speechSynthesis.cancel();
    speechBus.emit(null);
    setSpeaking(false);
    setLevel(0);
  }, [supported]);

  /** Speaks the text; `onEnd` runs when Alex finishes (not when interrupted). */
  const speak = useCallback(
    (text: string, onEnd?: () => void) => {
      if (!enabled || !supported || !text.trim()) {
        onEnd?.();
        return;
      }
      window.speechSynthesis.cancel();
      const my = ++token.current;
      const parts = sentences(text);
      setSpeaking(true);
      parts.forEach((part, i) => {
        const u = new SpeechSynthesisUtterance(part);
        if (voice.current) u.voice = voice.current;
        u.rate = 1.02;
        u.pitch = 0.95;
        u.onboundary = (e) => {
          // word starts drive the avatar's lip sync
          if (e.name === 'word' || e.name === undefined) {
            const rest = part.slice(e.charIndex);
            const word = rest.slice(0, e.charLength || rest.search(/\s|$/)).trim();
            if (word) speechBus.emit({ word, at: performance.now(), rate: u.rate });
          }
          setLevel(1);
          if (decay.current) window.clearTimeout(decay.current);
          decay.current = window.setTimeout(() => setLevel(0.25), 140);
        };
        if (i === parts.length - 1) {
          u.onend = () => {
            if (token.current !== my) return;
            speechBus.emit(null);
            setSpeaking(false);
            setLevel(0);
            onEnd?.();
          };
        }
        u.onerror = () => {
          if (token.current !== my) return;
          setSpeaking(false);
          setLevel(0);
        };
        window.speechSynthesis.speak(u);
      });
    },
    [enabled, supported],
  );

  useEffect(() => stop, [stop]);
  return { supported, speaking, level, speak, stop };
}

// ---------- Speech recognition (candidate speaking) ----------

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: { length: number; [i: number]: RecognitionResult };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  processLocally?: boolean;
  phrases?: unknown[];
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = (new () => Recognition) & {
  available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string>;
};
type PhraseCtor = new (phrase: string, boost?: number) => unknown;

const RecognitionImpl = (): RecognitionCtor | null =>
  typeof window === 'undefined' ? null : ((window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition ??
    null);

export type RecognitionError = 'not-allowed' | 'no-speech' | 'network' | 'audio-capture' | 'other';

/** English variants offered for recognition. Matching the speaker's accent matters more than anything else for accuracy. */
export const SPEECH_LANGS = [
  { id: 'en-IN', label: 'English (India)' },
  { id: 'en-US', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'en-AU', label: 'English (Australia)' },
  { id: 'en-CA', label: 'English (Canada)' },
  { id: 'en-IE', label: 'English (Ireland)' },
  { id: 'en-NZ', label: 'English (New Zealand)' },
  { id: 'en-SG', label: 'English (Singapore)' },
  { id: 'en-ZA', label: 'English (South Africa)' },
] as const;

const PREFS_KEY = 'tr:voice:prefs';
export interface VoicePrefs {
  lang: string;
  /** On-device recognition: audio stays on the device, but it is usually less accurate. */
  onDevice: boolean;
}

function defaultLang(): string {
  if (typeof navigator === 'undefined') return 'en-US';
  const langs = [...(navigator.languages ?? []), navigator.language].filter(Boolean);
  const exact = langs.find((l) => SPEECH_LANGS.some((s) => s.id.toLowerCase() === l.toLowerCase()));
  if (exact) return SPEECH_LANGS.find((s) => s.id.toLowerCase() === exact.toLowerCase())!.id;
  let tz = '';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* ignore */
  }
  if (/Asia\/(Kolkata|Calcutta)/.test(tz) || langs.some((l) => /-IN$/i.test(l))) return 'en-IN';
  return 'en-US';
}

export function loadVoicePrefs(): VoicePrefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<VoicePrefs> | null;
    if (raw && typeof raw.lang === 'string') return { lang: raw.lang, onDevice: Boolean(raw.onDevice) };
  } catch {
    /* storage unavailable */
  }
  return { lang: defaultLang(), onDevice: false };
}

function saveVoicePrefs(p: VoicePrefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

/**
 * Continuous dictation. Final phrases are delivered through `onFinal`; the in-progress phrase is
 * exposed as `interim`. Chrome ends sessions after silence or about a minute, so recognition
 * restarts until stopped, and words still in progress when a session ends are kept, not dropped.
 * The accent and on-device choice are the candidate's (stored per browser).
 */
export function useSpeechRecognition(opts: { phrases?: string[] } = {}) {
  const Impl = RecognitionImpl();
  const supported = Boolean(Impl);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<RecognitionError | null>(null);
  const [onDevice, setOnDevice] = useState(false);
  const [lastHeardAt, setLastHeardAt] = useState(0);
  const [prefs, setPrefsState] = useState<VoicePrefs>(() => loadVoicePrefs());
  const rec = useRef<Recognition | null>(null);
  const wanted = useRef(false);
  const pending = useRef('');
  const onFinal = useRef<(text: string) => void>(() => undefined);
  const phrases = useRef(opts.phrases);
  phrases.current = opts.phrases;

  /** Words heard but not yet finalised by the engine; delivered once, then cleared. */
  const flushPending = useCallback(() => {
    const text = pending.current.trim();
    pending.current = '';
    setInterim('');
    if (text) onFinal.current(text);
  }, []);

  const detach = useCallback((r: Recognition | null) => {
    if (!r) return;
    r.onresult = null;
    r.onerror = null;
    r.onend = null;
    try {
      r.abort();
    } catch {
      /* already stopped */
    }
  }, []);

  /** Stops listening. Words still being transcribed are kept and delivered first. */
  const stop = useCallback(() => {
    wanted.current = false;
    flushPending();
    detach(rec.current);
    rec.current = null;
    setListening(false);
  }, [flushPending, detach]);

  /** Stops listening for a submit: returns the words still being transcribed instead of delivering them. */
  const finish = useCallback((): string => {
    const tail = pending.current.trim();
    pending.current = '';
    wanted.current = false;
    detach(rec.current);
    rec.current = null;
    setInterim('');
    setListening(false);
    return tail;
  }, [detach]);

  const start = useCallback(
    async (handler: (text: string) => void) => {
      if (!Impl) return;
      onFinal.current = handler;
      setError(null);
      if (rec.current && wanted.current) return;
      const r = new Impl();
      r.lang = prefs.lang;
      r.continuous = true;
      r.interimResults = true;
      r.maxAlternatives = 1;
      let local = false;
      if (prefs.onDevice) {
        try {
          local = Boolean(Impl.available && (await Impl.available({ langs: [prefs.lang], processLocally: true })) === 'available');
        } catch {
          /* on-device recognition not offered */
        }
      }
      if (local) {
        r.processLocally = true;
        // Contextual biasing (on-device only in current browsers): expect security vocabulary.
        const Phrase = (window as unknown as { SpeechRecognitionPhrase?: PhraseCtor }).SpeechRecognitionPhrase;
        if (Phrase && phrases.current?.length) {
          try {
            r.phrases = phrases.current.slice(0, 80).map((p) => new Phrase(p, 3));
          } catch {
            /* biasing not supported */
          }
        }
      }
      setOnDevice(local);
      r.onresult = (e) => {
        let live = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i]!;
          const text = res[0].transcript;
          if (res.isFinal) {
            pending.current = '';
            if (text.trim()) onFinal.current(text.trim());
          } else live += text;
        }
        pending.current = live;
        setInterim(live.trim());
        setLastHeardAt(Date.now());
      };
      r.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return; // silence: keep listening
        if (e.error === 'phrases-not-supported' || e.error === 'language-not-supported') return; // the session restarts without them
        setError(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'not-allowed' : e.error === 'network' ? 'network' : e.error === 'audio-capture' ? 'audio-capture' : 'other');
        wanted.current = false;
      };
      r.onend = () => {
        // The engine ended the session (silence, time limit, network): keep what was heard so far.
        flushPending();
        if (wanted.current && rec.current === r) {
          try {
            r.start();
            return;
          } catch {
            /* fall through to stopped */
          }
        }
        if (rec.current === r) rec.current = null;
        setListening(false);
      };
      rec.current = r;
      wanted.current = true;
      try {
        r.start();
        setListening(true);
        setLastHeardAt(Date.now());
      } catch {
        setError('other');
      }
    },
    [Impl, prefs, flushPending],
  );

  /** Change accent or on-device mode; an open microphone restarts with the new settings. */
  const setPrefs = useCallback(
    (next: VoicePrefs) => {
      saveVoicePrefs(next);
      setPrefsState(next);
      const wasOn = wanted.current;
      const handler = onFinal.current;
      stop();
      if (wasOn) window.setTimeout(() => void startRef.current(handler), 150);
    },
    [stop],
  );
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => () => {
    wanted.current = false;
    detach(rec.current);
  }, [detach]);

  return { supported, listening, interim, error, onDevice, lastHeardAt, prefs, setPrefs, start, stop, finish };
}

/** A short, soft tone that tells the candidate the microphone is open. */
export function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.3);
    o.onended = () => void ctx.close();
  } catch {
    /* audio unavailable */
  }
}
