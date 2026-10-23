import type { SessionView } from '@threatready/contracts';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Flag,
  HelpCircle,
  Keyboard,
  Lightbulb,
  MessagesSquare,
  Mic,
  Mic2,
  MicOff,
  Pause,
  Play,
  Repeat2,
  Send,
  Settings2,
  ShieldAlert,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { formatClock } from '../../../lib/format';
import { Busy, ErrorAlert, useModal, useToast } from '../../../ui/components';
import { AvatarFallback } from '../avatar/AvatarFallback';
import { STATUS_LABEL } from '../avatar/StatusPill';
import { hasWebGL } from '../avatar/webgl';
import { useInterviewSession } from '../hooks/useInterviewSession';
import { useTabGuard } from '../hooks/useTabGuard';
import { chime, SPEECH_LANGS, useSpeech, useSpeechRecognition, type RecognitionError } from '../hooks/useVoice';
import { appendPhrase, SECURITY_PHRASES } from '../lib/transcript';
import '../room.css';

// The 3D stack is a separate chunk loaded only here.
const InterviewerStage = lazy(() => import('../avatar/InterviewerStage'));

const MAX = 4000;
/** Pauses the candidate can choose before auto-submit counts down, and the countdown length. */
const SILENCE_CHOICES = [5, 10, 20, 30] as const;
const COUNTDOWN_MS = 4000;
const SHORT_ANSWER_WORDS = 6;
/** Under this much answer time the timer turns red, says "Low time", and it is announced. */
const LOW_TIME_SEC = 120;

const wordsIn = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
/** The first question carries the greeting; "repeat" should not re-read it. */
const withoutGreeting = (q: string) => q.replace(/^Hi .*?Feel free to think out loud\.\s*/s, '');

/** Voice auto-submit is opt-in, remembered per browser with the pause the candidate chose. */
interface AutoSubmit {
  on: boolean;
  silenceSec: number;
}
const AUTO_KEY = 'tr:voice:autosubmit';
function loadAuto(): AutoSubmit {
  try {
    const v = JSON.parse(window.localStorage.getItem(AUTO_KEY) ?? 'null') as Partial<AutoSubmit> | null;
    if (v && typeof v.on === 'boolean' && SILENCE_CHOICES.includes(v.silenceSec as (typeof SILENCE_CHOICES)[number])) return { on: v.on, silenceSec: v.silenceSec! };
  } catch {
    /* storage unavailable */
  }
  return { on: false, silenceSec: 10 };
}
function saveAuto(v: AutoSubmit) {
  try {
    window.localStorage.setItem(AUTO_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
}

/** The transcript panel starts closed (the current question is always on screen); the choice is remembered. */
const TRANSCRIPT_KEY = 'tr:room:transcript-open';
const loadTranscriptOpen = () => {
  try {
    return window.localStorage.getItem(TRANSCRIPT_KEY) === '1';
  } catch {
    return false;
  }
};

/** What each recognition failure means for the candidate; all of them fall back to typing. */
const MIC_ERRORS: Record<Exclude<RecognitionError, 'no-speech'>, { title: string; body: string }> = {
  'not-allowed': { title: 'Microphone blocked', body: 'Allow microphone access in your browser’s site settings to answer by voice, or keep typing your answers.' },
  network: { title: 'Speech recognition unavailable', body: 'Your browser could not reach its speech service. Keep typing, or choose Use voice in Answer options to try again.' },
  'audio-capture': { title: 'No microphone found', body: 'Connect a microphone and choose Use voice in Answer options, or keep typing your answers.' },
  other: { title: 'Voice input stopped', body: 'Something interrupted speech recognition. Keep typing, or choose Use voice in Answer options to try again.' },
};

/** Counts down locally from the server's authoritative remaining time; it never drifts across refreshes. */
function useCountdown(s: SessionView) {
  const base = useMemo(() => ({ remaining: s.timing.remainingSec, at: Date.now() }), [s.timing.remainingSec, s.timing.serverNow]);
  const running = s.state === 'awaiting_answer' && Boolean(s.timing.runningSince);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return running ? Math.max(0, base.remaining - (now - base.at) / 1000) : base.remaining;
}

function TimerRing({ remaining, total, low }: { remaining: number; total: number; low: boolean }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? remaining / total : 0;
  return (
    <div className={`timer ${low ? 'low' : ''}`} role="timer" aria-label={low ? 'Time remaining, running low' : 'Time remaining'}>
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden>
        <circle cx="22" cy="22" r={r} stroke="var(--surface-3)" strokeWidth="4" fill="none" />
        <circle cx="22" cy="22" r={r} stroke={low ? 'var(--bad)' : 'var(--ok)'} strokeWidth="4" fill="none" strokeLinecap="round" strokeDasharray={`${c * frac} ${c}`} transform="rotate(-90 22 22)" style={{ transition: 'stroke-dasharray 1s linear' }} />
      </svg>
      <div>
        {low ? (
          <span className="low-label"><AlertTriangle className="icon" aria-hidden /> Low time</span>
        ) : (
          <span className="muted">Time left</span>
        )}
        <strong className="tabular">{formatClock(remaining)}</strong>
      </div>
    </div>
  );
}

function Waveform({ active }: { active: boolean }) {
  return (
    <span className={`waveform ${active ? 'on' : ''}`} aria-hidden>
      {Array.from({ length: 5 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 0.12}s` }} />)}
    </span>
  );
}

type Capture = 'answer' | 'clarify';

/**
 * Shown when the candidate comes back after switching away from the interview tab. A reminder only:
 * nothing is recorded and the score is unaffected. A proper modal: focus inside, Tab kept in, Escape
 * closes, the room behind is inert, and focus goes back to where it was.
 */
function TabSwitchWarning({ count, onDismiss }: { count: number; onDismiss: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useModal(box, onDismiss, btn);
  // On <body>: the room's entrance animation would otherwise trap position: fixed inside it.
  return createPortal(
    <div className="tab-guard" role="presentation">
      <div ref={box} className="tab-guard-box card fade-in" role="dialog" aria-modal="true" aria-labelledby="tab-guard-title" aria-describedby="tab-guard-body">
        <span className="icon-tile warn"><ShieldAlert className="icon lg" aria-hidden /></span>
        <h2 id="tab-guard-title">You switched away from the interview</h2>
        <p id="tab-guard-body" className="subtle">
          The timer kept running while you were away. As in a real interview, try to stay on this tab until you finish.
          {count > 1 ? ` You have switched away ${count} times.` : ''} This is a reminder only; it doesn’t affect your score.
        </p>
        <button ref={btn} className="btn primary" type="button" onClick={onDismiss}>Back to the interview</button>
      </div>
    </div>,
    document.body,
  );
}

type MicState = 'idle' | 'checking' | 'ok' | 'blocked' | 'missing' | 'error';
const MIC_MESSAGE: Record<Exclude<MicState, 'idle' | 'checking'>, string> = {
  ok: 'Your microphone works.',
  blocked: 'Microphone access is blocked. Allow it in your browser’s site settings, or answer by typing.',
  missing: 'No microphone was found. Connect one, or answer by typing.',
  error: 'The microphone could not be checked. You can still start and type your answers.',
};

/** Optional check before Start: asks for microphone access now, not in the middle of the first answer. */
function MicCheck() {
  const [state, setState] = useState<MicState>('idle');
  async function check() {
    if (!navigator.mediaDevices?.getUserMedia) return setState('error');
    setState('checking');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setState('ok');
    } catch (e) {
      const name = (e as DOMException | undefined)?.name;
      setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'blocked' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'missing' : 'error');
    }
  }
  const done = state !== 'idle' && state !== 'checking';
  return (
    <div className="mic-check">
      <button className="btn sm" type="button" onClick={() => void check()} disabled={state === 'checking'}>
        {state === 'checking' ? <Busy label="Checking…" /> : <><Mic className="icon sm" aria-hidden /> Test microphone</>}
      </button>
      <span role="status" className={state === 'ok' ? 'ok row tight' : 'bad row tight'}>
        {done && (state === 'ok' ? <CheckCircle2 className="icon sm" aria-hidden /> : <CircleAlert className="icon sm" aria-hidden />)}
        {done ? MIC_MESSAGE[state] : ''}
      </span>
    </div>
  );
}

export default function InterviewRoom({ initial }: { initial: SessionView }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { session, phase, status, streaming, error, feedback, reply, start, submit, clarify, control, retry } = useInterviewSession(initial);
  const config = session.config;
  const [muted, setMuted] = useState(false);
  const speech = useSpeech(Boolean(config?.speakQuestions || config?.voiceAnswers) && !muted);
  const phrases = useMemo(() => [...SECURITY_PHRASES, ...(session.roleTitle ?? '').split(/[^A-Za-z0-9+#.-]+/).filter((w) => w.length > 2)], [session.roleTitle]);
  const rec = useSpeechRecognition({ phrases });
  const [micOff, setMicOff] = useState(false);
  const voiceMode = Boolean(config?.voiceAnswers) && rec.supported && !micOff && rec.error !== 'not-allowed';

  const [answer, setAnswer] = useState('');
  const [typing, setTyping] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [showTranscript, setShowTranscript] = useState(loadTranscriptOpen);
  const [nudge, setNudge] = useState(false);
  const [asking, setAsking] = useState(false);
  const [clarifyText, setClarifyText] = useState('');
  const [auto, setAuto] = useState(loadAuto);
  const [countdown, setCountdown] = useState<number | null>(null);
  /** Screen-reader announcements: auto-submit countdown and low time. */
  const [announce, setAnnounce] = useState('');
  // The 2D interviewer when WebGL is missing or the 3D view fails; voice and everything else still work.
  const [flat, setFlat] = useState(() => !hasWebGL());
  const capture = useRef<Capture>('answer');
  const typingTimer = useRef<number | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  /** "Keep answering" restarts the silence clock for auto-submit. */
  const heldAt = useRef(0);
  const endBtn = useRef<HTMLButtonElement>(null);
  const keepGoingBtn = useRef<HTMLButtonElement>(null);
  const endAsked = useRef(false);
  const remaining = useCountdown(session);
  const tabGuard = useTabGuard(session.id, ['asking', 'awaiting_answer', 'evaluating'].includes(session.state));
  const turn = session.currentTurn;
  const draftKey = turn ? `tr:draft:${turn.turnId}` : null;
  const canAnswer = session.state === 'awaiting_answer' && phase === 'idle' && !!turn;

  const updateAuto = (v: AutoSubmit) => {
    setAuto(v);
    saveAuto(v);
  };

  // Restore a typed draft after a refresh (per-viewer convenience only).
  useEffect(() => {
    if (!draftKey) return setAnswer('');
    try {
      setAnswer(window.localStorage.getItem(draftKey) ?? '');
    } catch {
      setAnswer('');
    }
  }, [draftKey]);

  const saveDraft = useCallback(
    (v: string) => {
      if (!draftKey) return;
      try {
        window.localStorage.setItem(draftKey, v);
      } catch {
        /* storage unavailable */
      }
    },
    [draftKey],
  );

  /** Open the microphone for the answer (voice mode). */
  const listen = useCallback(
    (mode: Capture = 'answer') => {
      if (!voiceMode) return;
      capture.current = mode;
      chime();
      void rec.start((text) => {
        if (capture.current === 'clarify') {
          setClarifyText((c) => appendPhrase(c, text));
        } else {
          setAnswer((a) => {
            const next = appendPhrase(a, text).slice(0, MAX);
            saveDraft(next);
            return next;
          });
        }
      });
    },
    [voiceMode, rec, saveDraft],
  );

  // Alex speaks each new question once it has fully arrived; in voice mode the mic opens after.
  const spoken = useRef<string | null>(null);
  useEffect(() => {
    if (!turn || session.state !== 'awaiting_answer' || spoken.current === turn.turnId) return;
    spoken.current = turn.turnId;
    heldAt.current = 0;
    rec.stop();
    if (speech.supported && (config?.speakQuestions || config?.voiceAnswers) && !muted) speech.speak(turn.question, () => listen('answer'));
    else listen('answer');
  }, [turn?.turnId, session.state]);

  // Speak Alex's reply to a clarifying question, then go back to listening for the answer.
  const clarCount = turn?.clarifications.length ?? 0;
  const spokenClar = useRef(0);
  useEffect(() => {
    if (!turn || clarCount <= spokenClar.current) {
      spokenClar.current = clarCount;
      return;
    }
    spokenClar.current = clarCount;
    const last = turn.clarifications[clarCount - 1]!;
    if (speech.supported && !muted && (config?.speakQuestions || config?.voiceAnswers)) speech.speak(last.answer, () => listen('answer'));
    else listen('answer');
  }, [clarCount]);

  // Stop listening whenever the candidate cannot answer (evaluating, paused, finished).
  useEffect(() => {
    if (!canAnswer && phase !== 'replying') rec.stop();
  }, [canAnswer, phase, rec]);

  useEffect(() => {
    if (['completed', 'scoring', 'report_ready', 'expired'].includes(session.state)) {
      speech.stop();
      rec.stop();
      navigate(`/interview-prep/sessions/${session.id}`, { replace: true });
    }
  }, [session.state, session.id, navigate, speech, rec]);

  // Practice-mode feedback also arrives as a toast so it is noticed without scrolling.
  useEffect(() => {
    if (!feedback) return;
    const f = feedback.feedback;
    toast({ tone: 'info', title: 'Practice feedback', body: [f.demonstrated.length ? `Covered: ${f.demonstrated.join(', ')}.` : '', f.tip ?? ''].filter(Boolean).join(' ') });
  }, [feedback, toast]);

  // Every recognition failure is explained and the room switches to typing (a blocked microphone
  // already leaves voice mode). "Use voice" in Answer options tries again.
  useEffect(() => {
    if (!rec.error || rec.error === 'no-speech') return;
    toast({ tone: 'error', ...MIC_ERRORS[rec.error] });
    if (rec.error !== 'not-allowed') setMicOff(true);
  }, [rec.error, toast]);

  // Keep the newest exchange in view inside the transcript panel only.
  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.transcript.length, showTranscript]);

  // The end confirmation takes focus when it opens and gives it back to "End interview" when dismissed.
  useEffect(() => {
    if (confirmEnd) keepGoingBtn.current?.focus();
    else if (endAsked.current) endBtn.current?.focus();
    endAsked.current = confirmEnd;
  }, [confirmEnd]);

  // Low time is announced, not only shown in red: once at two minutes, once at one.
  const lowAnnounced = useRef<number | null>(null);
  useEffect(() => {
    if (session.state !== 'awaiting_answer') return;
    const mark = remaining <= 60 ? 60 : remaining <= LOW_TIME_SEC ? LOW_TIME_SEC : null;
    if (mark && (lowAnnounced.current == null || mark < lowAnnounced.current)) {
      lowAnnounced.current = mark;
      setAnnounce(mark === 60 ? 'One minute of answer time left.' : 'Two minutes of answer time left.');
    }
  }, [remaining, session.state]);

  const doSubmit = useCallback(
    async (force = false) => {
      if (!turn || phase !== 'idle') return;
      // Words still being transcribed belong to the answer; never drop them on submit.
      const tail = rec.listening ? rec.finish() : '';
      const text = (tail ? appendPhrase(answer, tail) : answer).slice(0, MAX).trim();
      if (tail) {
        setAnswer(text);
        saveDraft(text);
      }
      if (!text) return;
      if (!force && wordsIn(text) < SHORT_ANSWER_WORDS) {
        setNudge(true);
        return;
      }
      setNudge(false);
      setCountdown(null);
      speech.stop();
      await submit(text);
      if (draftKey) {
        try {
          window.localStorage.removeItem(draftKey);
        } catch {
          /* ignore */
        }
      }
    },
    [answer, turn, phase, rec, speech, submit, draftKey, saveDraft],
  );

  // Voice, when the candidate opted in: after the pause they chose, count down and submit
  // (cancelled by speaking again or by "Keep answering").
  useEffect(() => {
    if (!voiceMode || !rec.listening || capture.current !== 'answer' || !auto.on) {
      setCountdown(null);
      return;
    }
    const silenceMs = auto.silenceSec * 1000;
    const t = setInterval(() => {
      const silent = Date.now() - Math.max(rec.lastHeardAt, heldAt.current);
      if (rec.interim || wordsIn(answer) < 8 || silent < silenceMs) return setCountdown(null);
      const left = silenceMs + COUNTDOWN_MS - silent;
      if (left <= 0) {
        clearInterval(t);
        setCountdown(null);
        void doSubmit(true);
      } else setCountdown(Math.ceil(left / 1000));
    }, 250);
    return () => clearInterval(t);
  }, [voiceMode, rec.listening, rec.lastHeardAt, rec.interim, answer, auto.on, auto.silenceSec, doSubmit]);

  // Announce the countdown once, when it starts.
  const counting = countdown != null;
  useEffect(() => {
    if (counting) setAnnounce(`Submitting your answer in ${Math.round(COUNTDOWN_MS / 1000)} seconds. Keep talking, or choose Keep answering, to carry on.`);
  }, [counting]);

  // Voice clarification: send once the candidate pauses after asking.
  useEffect(() => {
    if (!asking || !voiceMode || capture.current !== 'clarify' || !clarifyText.trim()) return;
    const t = setTimeout(() => {
      if (Date.now() - rec.lastHeardAt < 1500 || rec.interim) return;
      rec.stop();
      setAsking(false);
      void clarify(clarifyText);
      setClarifyText('');
    }, 1800);
    return () => clearTimeout(t);
  }, [asking, voiceMode, clarifyText, rec.lastHeardAt, rec.interim, rec, clarify]);

  function onType(v: string) {
    setAnswer(v);
    setNudge(false);
    setTyping(true);
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => setTyping(false), 1200);
    saveDraft(v);
  }

  function repeatQuestion() {
    if (!turn) return;
    rec.stop();
    if (speech.supported && !muted) speech.speak(withoutGreeting(turn.question), () => listen('answer'));
    else toast({ tone: 'info', title: 'The question', body: withoutGreeting(turn.question) });
  }

  function startAsking() {
    speech.stop();
    setAsking(true);
    setClarifyText('');
    if (voiceMode) {
      rec.stop();
      window.setTimeout(() => listen('clarify'), 150);
    }
  }

  function sendTypedClarification() {
    if (!clarifyText.trim()) return;
    setAsking(false);
    void clarify(clarifyText);
    setClarifyText('');
  }

  function toggleTranscript() {
    setShowTranscript((open) => {
      try {
        window.localStorage.setItem(TRANSCRIPT_KEY, open ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !open;
    });
  }

  const questionText = streaming ? streaming.text : turn?.question ?? '';
  const topic = streaming?.topic ?? turn?.topic;
  const qNumber = Math.max(streaming?.questionNumber ?? session.progress.questionNumber, 1);
  const isFollowUp = (streaming?.kind ?? turn?.kind) === 'follow_up';
  const lowTime = remaining <= LOW_TIME_SEC && session.state === 'awaiting_answer';
  const speaking = phase === 'streaming' || phase === 'replying' || speech.speaking;
  const words = wordsIn(answer);
  const answeredCount = session.transcript.filter((t) => t.answer).length;
  const stageStatus = rec.listening && !speaking ? 'listening' : status;
  const stage = { status: stageStatus, speaking, speechLevel: speech.speaking ? speech.level : undefined, candidateTyping: typing || Boolean(rec.interim) };
  const voiceAvailable = Boolean(config?.voiceAnswers) && rec.supported;

  return (
    <div className="room page">
      <p className="sr-only" aria-live="assertive" aria-atomic="true">{announce}</p>
      <header className="room-head">
        <div className="stack" style={{ gap: 8, minWidth: 0 }}>
          <div className="eyebrow" style={{ marginBottom: 0 }}><Mic2 className="icon sm" aria-hidden /> Interview</div>
          <h1 className="room-title">{session.roleTitle ?? 'Your interview'}</h1>
          <div className="row wrap tight">
            <span className={`status-pill s-${stageStatus}`} aria-live="polite">
              <span className="dot live" aria-hidden /> {STATUS_LABEL[stageStatus]}
            </span>
            {config && <span className="badge">{config.mode === 'practice' ? 'Practice mode' : 'Realistic mode'}</span>}
            {voiceMode && <span className="badge accent"><Mic className="icon sm" aria-hidden /> Voice interview</span>}
          </div>
        </div>
        <div className="row wrap">
          <div className="progress-box" aria-label="Progress">
            <span className="muted">{isFollowUp ? 'Follow-up to' : 'Question'}</span>
            <strong className="tabular">{qNumber}</strong>
            <span className="muted">{answeredCount} answered</span>
          </div>
          <TimerRing remaining={remaining} total={session.timing.durationSec} low={lowTime} />
          {(config?.speakQuestions || config?.voiceAnswers) && speech.supported && (
            <button className="btn icon-only" type="button" aria-pressed={muted} aria-label="Mute Alex" title={muted ? 'Alex is muted' : 'Mute Alex'} onClick={() => { if (!muted) speech.stop(); setMuted((m) => !m); }}>
              {muted ? <VolumeX className="icon" aria-hidden /> : <Volume2 className="icon" aria-hidden />}
            </button>
          )}
          {session.state === 'awaiting_answer' && (
            <button className="btn icon-only" type="button" onClick={() => { rec.stop(); speech.stop(); void control('pause'); }} disabled={phase !== 'idle'} aria-label="Pause the interview" title="Pause">
              <Pause className="icon" aria-hidden />
            </button>
          )}
          {['awaiting_answer', 'paused'].includes(session.state) && (
            <button ref={endBtn} className="btn outline" type="button" onClick={() => setConfirmEnd(true)}>
              <Flag className="icon sm" aria-hidden /> End interview
            </button>
          )}
        </div>
      </header>

      {tabGuard.warning && <TabSwitchWarning count={tabGuard.count} onDismiss={tabGuard.dismiss} />}

      {confirmEnd && (
        <div
          className="alert warn wrap fade-in"
          style={{ marginBottom: 16 }}
          role="alertdialog"
          aria-labelledby="end-title"
          aria-describedby="end-desc"
          onKeyDown={(e) => { if (e.key === 'Escape') setConfirmEnd(false); }}
        >
          <Flag className="icon" aria-hidden />
          <div style={{ flex: '1 1 200px' }}>
            <strong id="end-title">End now and get your report?</strong>
            <p id="end-desc" className="subtle" style={{ fontSize: 13.5 }}>{answeredCount} answer{answeredCount === 1 ? '' : 's'} so far. Unanswered questions are not scored.</p>
          </div>
          <div className="row tight wrap">
            <button className="btn danger sm" type="button" onClick={() => { rec.stop(); speech.stop(); void control('end'); }}>End interview</button>
            <button ref={keepGoingBtn} className="btn ghost sm" type="button" onClick={() => setConfirmEnd(false)}>Keep going</button>
          </div>
        </div>
      )}

      <div className="room-grid">
        <section className="stage-col" aria-label="Interviewer">
          <div className="stage-frame">
            {flat ? (
              <AvatarFallback status={stageStatus} speaking={speaking} candidateTyping={stage.candidateTyping} />
            ) : (
              <Suspense fallback={<AvatarFallback status={stageStatus} speaking={speaking} candidateTyping={stage.candidateTyping} />}>
                <InterviewerStage {...stage} onFallback={() => setFlat(true)} />
              </Suspense>
            )}
            {!flat && (
              <div className="stage-overlay" aria-hidden>
                <span className={`stage-chip s-${stageStatus}`}>
                  <Waveform active={speaking} /> Alex · {speaking ? 'Speaking' : STATUS_LABEL[stageStatus]}
                </span>
                {session.state !== 'planned' && <span className="stage-chip">{isFollowUp ? 'Follow-up' : `Q${qNumber}`}{topic ? ` · ${topic}` : ''}</span>}
              </div>
            )}
          </div>

          <div className={`question-card card ${phase === 'streaming' ? 'streaming' : ''}`} aria-live={phase === 'streaming' ? 'off' : 'polite'} aria-atomic="true">
            {session.state === 'planned' ? (
              <div className="ready">
                <div className="stack" style={{ gap: 6, flex: 1, minWidth: 'min(260px, 100%)' }}>
                  <h2>Your interview is ready</h2>
                  <p className="subtle">
                    About {config?.durationMin} minutes. Alex's questions follow your answers, with follow-ups when useful.{' '}
                    {config?.voiceAnswers ? 'Alex will speak each question and listen for your answer; your words appear on screen so you can edit them. Your browser will ask to use the microphone. ' : ''}
                    The timer runs only while you are answering, and you can pause at any time.
                  </p>
                  {voiceAvailable && <MicCheck />}
                </div>
                <button className="btn primary lg" type="button" onClick={() => void start()} disabled={phase !== 'idle'}>
                  {phase === 'starting' ? <Busy label="Starting…" /> : <><Play className="icon sm" aria-hidden /> Start interview</>}
                </button>
              </div>
            ) : (
              <>
                <div className="row between wrap" style={{ marginBottom: 10, gap: 8 }}>
                  <div className="row tight wrap">
                    <span className={`badge ${isFollowUp ? 'warn' : 'accent'}`}>{isFollowUp ? 'Follow-up' : `Question ${qNumber}`}</span>
                    {topic && <span className="badge">{topic}</span>}
                  </div>
                  {canAnswer && (
                    <div className="row tight wrap">
                      {speech.speaking ? (
                        <button className="btn ghost sm" type="button" onClick={() => { speech.stop(); listen('answer'); }} title="Stop Alex reading the question aloud">
                          <SkipForward className="icon sm" aria-hidden /> Skip reading
                        </button>
                      ) : (
                        <button className="btn ghost sm" type="button" onClick={repeatQuestion} title="Ask Alex to repeat the question">
                          <Repeat2 className="icon sm" aria-hidden /> Repeat
                        </button>
                      )}
                      <button className="btn ghost sm" type="button" onClick={startAsking} disabled={clarCount >= 3} title={clarCount >= 3 ? 'Up to three clarifying questions per question' : 'Ask Alex a clarifying question'}>
                        <HelpCircle className="icon sm" aria-hidden /> Ask Alex
                      </button>
                    </div>
                  )}
                </div>
                {questionText ? (
                  <p className="question-text">{questionText}{phase === 'streaming' && <span className="caret" aria-hidden />}</p>
                ) : (
                  <p className="subtle row thinking">
                    <span className="dots" aria-hidden><i /><i /><i /></span>
                    {phase === 'evaluating' || phase === 'recovering' ? 'Alex is reviewing your answer' : 'Alex is preparing the next question'}
                  </p>
                )}

                {(turn?.clarifications.length || reply || asking) && (
                  <div className="clarify-thread">
                    {turn?.clarifications.map((c, i) => (
                      <div key={i} className="clar">
                        <span className="you">You: {c.question}</span>
                        <span className="alex">Alex: {c.answer}</span>
                      </div>
                    ))}
                    {reply && (
                      <div className="clar">
                        <span className="you">You: {reply.question}</span>
                        <span className="alex">Alex: {reply.text || '…'}</span>
                      </div>
                    )}
                    {asking && (
                      voiceMode ? (
                        <div className="clar asking">
                          <span className="you"><Mic className="icon sm" aria-hidden /> {clarifyText || rec.interim || 'Ask your question, Alex is listening…'}</span>
                          <button className="btn ghost sm" type="button" onClick={() => { rec.stop(); setAsking(false); listen('answer'); }}>Cancel</button>
                        </div>
                      ) : (
                        <form className="row tight" onSubmit={(e) => { e.preventDefault(); sendTypedClarification(); }}>
                          <input className="input" autoFocus value={clarifyText} onChange={(e) => setClarifyText(e.target.value)} maxLength={500} placeholder="e.g. Could you clarify what you mean by containment here?" aria-label="Your question for Alex" />
                          <button className="btn sm" type="submit" disabled={clarifyText.trim().length < 2}>Ask</button>
                          <button className="btn ghost sm" type="button" onClick={() => setAsking(false)}>Cancel</button>
                        </form>
                      )
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        <section className="answer-col" aria-label="Answer and controls">
          <div className="card stack composer">
            {error != null && <ErrorAlert error={error} onRetry={() => void retry()} />}
            {session.state === 'paused' ? (
              <div className="stack" style={{ alignItems: 'center', textAlign: 'center', padding: '20px 0' }}>
                <span className="icon-tile warn"><Pause className="icon lg" aria-hidden /></span>
                <h2>Interview paused</h2>
                <p className="subtle">The timer is stopped. Your answers so far are saved.</p>
                <button className="btn primary" type="button" onClick={() => { spoken.current = null; void control('resume'); }}>
                  <Play className="icon sm" aria-hidden /> Resume interview
                </button>
              </div>
            ) : (
              <>
                {voiceMode && (
                  <div className={`voice-panel ${rec.listening && capture.current === 'answer' ? 'on' : ''}`}>
                    <button
                      type="button"
                      className="mic-orb"
                      disabled={!canAnswer}
                      aria-pressed={rec.listening}
                      aria-label={rec.listening ? 'Stop listening' : 'Start speaking your answer'}
                      onClick={() => (rec.listening ? rec.stop() : (speech.stop(), listen('answer')))}
                    >
                      {rec.listening ? <Mic className="icon lg" aria-hidden /> : <MicOff className="icon lg" aria-hidden />}
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong>{!canAnswer ? 'Wait for the question' : rec.listening ? (capture.current === 'clarify' ? 'Listening for your question' : 'Listening… speak your answer') : speech.speaking ? 'Alex is speaking' : 'Microphone paused'}</strong>
                      <p className="hint">{rec.interim ? `“${rec.interim}”` : rec.listening ? 'Your words appear below and stay editable.' : 'Tap the microphone to speak, or type below.'}</p>
                    </div>
                    {countdown != null && (
                      <button type="button" className="countdown" onClick={() => { heldAt.current = Date.now(); setCountdown(null); }}>
                        Keep answering <span>Auto-submit in {countdown} s</span>
                      </button>
                    )}
                  </div>
                )}
                <div className="row between wrap" style={{ gap: 8 }}>
                  <label htmlFor="answer" className="field-label">Your answer</label>
                  <button type="button" className="btn ghost sm disclosure-btn" onClick={() => setShowOptions((v) => !v)} aria-expanded={showOptions} aria-controls="answer-options">
                    <Settings2 className="icon sm" aria-hidden /> Answer options <ChevronDown className="icon sm chev-rot" aria-hidden />
                  </button>
                </div>
                {showOptions && (
                  <div id="answer-options" className="room-options fade-in">
                    <div className="stack" style={{ gap: 8 }}>
                      <h3><Lightbulb className="icon sm" aria-hidden style={{ verticalAlign: -2 }} /> A strong answer covers</h3>
                      <div className="tips">
                        <span><b>Context</b>What was the situation or system?</span>
                        <span><b>Approach</b>What did you do, step by step?</span>
                        <span><b>Decision</b>Why that way? What trade-offs?</span>
                        <span><b>Result</b>What happened, and how did you verify it?</span>
                      </div>
                    </div>
                    {voiceAvailable && (
                      <div className="stack" style={{ gap: 8 }}>
                        <h3>Voice</h3>
                        <div className="row between tight">
                          <span className="hint">{micOff ? 'You are typing your answers.' : rec.onDevice ? 'Speech is transcribed on this device.' : 'Speech is transcribed by your browser’s speech service.'}</span>
                          <button className="btn ghost sm" type="button" onClick={() => { rec.stop(); setMicOff((m) => !m); }}>
                            {micOff ? <><Mic className="icon sm" aria-hidden /> Use voice</> : <><Keyboard className="icon sm" aria-hidden /> Type instead</>}
                          </button>
                        </div>
                        {voiceMode && (
                          <div className="voice-settings" role="group" aria-label="Voice settings">
                            <label className="field-label" htmlFor="speech-lang">Your accent</label>
                            <select id="speech-lang" className="input" value={rec.prefs.lang} onChange={(e) => rec.setPrefs({ ...rec.prefs, lang: e.target.value })}>
                              {SPEECH_LANGS.map((l) => (
                                <option key={l.id} value={l.id}>{l.label}</option>
                              ))}
                            </select>
                            <label className="row tight" style={{ cursor: 'pointer' }}>
                              <input type="checkbox" checked={rec.prefs.onDevice} onChange={(e) => rec.setPrefs({ ...rec.prefs, onDevice: e.target.checked })} />
                              <span>Transcribe on this device when possible (more private, usually less accurate)</span>
                            </label>
                            <label className="row tight" style={{ cursor: 'pointer' }}>
                              <input type="checkbox" checked={auto.on} onChange={(e) => updateAuto({ ...auto, on: e.target.checked })} />
                              <span>Submit my answer automatically when I stop speaking</span>
                            </label>
                            {auto.on && (
                              <div className="field">
                                <label className="field-label" htmlFor="auto-silence">After a pause of</label>
                                <select id="auto-silence" className="input" aria-describedby="auto-silence-hint" value={auto.silenceSec} onChange={(e) => updateAuto({ ...auto, silenceSec: Number(e.target.value) })}>
                                  {SILENCE_CHOICES.map((s) => (
                                    <option key={s} value={s}>{s} seconds</option>
                                  ))}
                                </select>
                                <span id="auto-silence-hint" className="hint">A {Math.round(COUNTDOWN_MS / 1000)}-second countdown follows, with a button to keep answering.</span>
                              </div>
                            )}
                            <p className="hint">Choosing the accent closest to yours makes the biggest difference. Speak at a steady pace, close to the microphone; common security terms such as SIEM, EDR and MITRE ATT&amp;CK are corrected automatically, and you can edit the text before submitting.</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <textarea
                  id="answer"
                  className="textarea answer-box"
                  value={answer}
                  onChange={(e) => onType(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void doSubmit();
                    }
                  }}
                  maxLength={MAX}
                  disabled={!canAnswer}
                  placeholder={canAnswer ? (voiceMode ? 'Speak, or type here. You can edit what was transcribed.' : 'Type your answer. Explain your reasoning as you would out loud.') : session.state === 'planned' ? 'Start the interview to answer.' : 'Wait for the question…'}
                  aria-describedby="answer-help answer-kbd"
                />
                {nudge && (
                  <div className="alert warn fade-in" role="status">
                    <Lightbulb className="icon" aria-hidden />
                    <div className="stack" style={{ gap: 6, flex: 1 }}>
                      <span>That's a short answer. Interviewers look for your reasoning: what you would do, why, and an example. It's also fine to say you don't know and how you would find out.</span>
                      <div className="row tight">
                        <button className="btn sm" type="button" onClick={() => { setNudge(false); if (voiceMode) listen('answer'); }}>Add more</button>
                        <button className="btn ghost sm" type="button" onClick={() => void doSubmit(true)}>Submit anyway</button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="composer-foot">
                  <span id="answer-help" className="hint tabular">
                    {words} word{words === 1 ? '' : 's'} · {answer.length.toLocaleString('en-IN')}/4,000
                  </span>
                  <span id="answer-kbd" className="hint"><kbd>Ctrl</kbd> + <kbd>Enter</kbd> submits</span>
                  {config?.voiceAnswers && !voiceMode && (
                    <span className="hint row tight"><Keyboard className="icon sm" aria-hidden /> {rec.supported ? 'Typing mode' : 'Voice answers aren’t supported in this browser'}</span>
                  )}
                  <button className="btn primary" type="button" onClick={() => void doSubmit()} disabled={!canAnswer || !answer.trim()}>
                    {phase === 'evaluating' ? <Busy label="Submitting…" /> : <><Send className="icon sm" aria-hidden /> Submit answer</>}
                  </button>
                </div>
              </>
            )}

            {feedback && (
              <div className="alert info fade-in" role="status">
                <Lightbulb className="icon" aria-hidden />
                <div className="stack" style={{ gap: 4 }}>
                  <strong>Practice feedback</strong>
                  {feedback.feedback.demonstrated.length > 0 && <span>Covered: {feedback.feedback.demonstrated.join(', ')}</span>}
                  {feedback.feedback.missing.length > 0 && <span>Consider: {feedback.feedback.missing.join(', ')}</span>}
                  {feedback.feedback.tip && <span className="subtle">{feedback.feedback.tip}</span>}
                </div>
              </div>
            )}
          </div>

          <section className="card transcript" aria-labelledby="transcript-title">
            <div className="transcript-head">
              <h2 id="transcript-title" style={{ flex: 1 }}>
                <button type="button" className="disclosure-btn" aria-expanded={showTranscript} aria-controls="transcript-list" onClick={toggleTranscript}>
                  <span className="row tight"><MessagesSquare className="icon" aria-hidden /> Transcript</span>
                  <span className="row tight muted" style={{ fontSize: 13, fontWeight: 500 }}>
                    {answeredCount} answered <ChevronDown className="icon sm chev-rot" aria-hidden />
                  </span>
                </button>
              </h2>
            </div>
            {showTranscript && (
              <div id="transcript-list" className="chat" ref={chatRef}>
                {session.transcript.length === 0 && <p className="muted" style={{ fontSize: 13.5 }}>The conversation appears here as you go.</p>}
                {session.transcript.map((t) => (
                  <div key={t.turnId} className="chat-turn">
                    <div className="bubble alex">
                      <span className="who">Alex · {t.kind === 'follow_up' ? 'Follow-up' : `Q${t.questionNumber}`}</span>
                      {t.question}
                    </div>
                    {t.clarifications.map((c, i) => (
                      <div key={i} className="chat-turn">
                        <div className="bubble you aside"><span className="who">You asked</span>{c.question}</div>
                        <div className="bubble alex aside"><span className="who">Alex</span>{c.answer}</div>
                      </div>
                    ))}
                    {t.answer && (
                      <div className="bubble you">
                        <span className="who">You</span>
                        {t.answer}
                      </div>
                    )}
                    {t.practiceFeedback?.tip && <p className="hint" style={{ paddingLeft: 4 }}>Tip: {t.practiceFeedback.tip}</p>}
                  </div>
                ))}
              </div>
            )}
          </section>
        </section>
      </div>
    </div>
  );
}
