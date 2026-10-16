import type { SessionView } from '@threatready/contracts';
import {
  CornerDownLeft,
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
import { ErrorAlert, useToast } from '../../../ui/components';
import { AvatarFallback } from '../avatar/AvatarFallback';
import { hasWebGL } from '../avatar/webgl';
import { useInterviewSession } from '../hooks/useInterviewSession';
import { useTabGuard } from '../hooks/useTabGuard';
import { chime, SPEECH_LANGS, useSpeech, useSpeechRecognition } from '../hooks/useVoice';
import { appendPhrase, SECURITY_PHRASES } from '../lib/transcript';
import '../room.css';

// The 3D stack is a separate chunk loaded only here.
const InterviewerStage = lazy(() => import('../avatar/InterviewerStage'));

const STATUS_TEXT = {
  preparing: 'Preparing',
  asking: 'Asking',
  listening: 'Listening',
  evaluating: 'Evaluating',
  paused: 'Paused',
  finished: 'Finished',
} as const;

const MAX = 4000;
/** Silence before the auto-submit countdown appears, and the countdown length. */
const SILENCE_MS = 5500;
const COUNTDOWN_MS = 4000;
const SHORT_ANSWER_WORDS = 6;

const wordsIn = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
/** The first question carries the greeting; "repeat" should not re-read it. */
const withoutGreeting = (q: string) => q.replace(/^Hi .*?Feel free to think out loud\.\s*/s, '');

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
    <div className={`timer ${low ? 'low' : ''}`} role="timer" aria-label="Time remaining">
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden>
        <circle cx="22" cy="22" r={r} stroke="var(--surface-3)" strokeWidth="4" fill="none" />
        <circle cx="22" cy="22" r={r} stroke={low ? 'var(--accent)' : 'var(--ok)'} strokeWidth="4" fill="none" strokeLinecap="round" strokeDasharray={`${c * frac} ${c}`} transform="rotate(-90 22 22)" style={{ transition: 'stroke-dasharray 1s linear' }} />
      </svg>
      <div>
        <span className="muted">Time left</span>
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

/** Shown when the candidate comes back after switching away from the interview tab. */
function TabSwitchWarning({ count, onDismiss }: { count: number; onDismiss: () => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    btn.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);
  // On <body>: the room's entrance animation would otherwise trap position: fixed inside it.
  return createPortal(
    <div className="tab-guard" role="presentation">
      <div className="tab-guard-box card fade-in" role="alertdialog" aria-modal="true" aria-labelledby="tab-guard-title" aria-describedby="tab-guard-body">
        <span className="icon-tile warn"><ShieldAlert className="icon lg" aria-hidden /></span>
        <h2 id="tab-guard-title">You’re not allowed to switch tabs</h2>
        <p id="tab-guard-body" className="subtle">
          Stay on this tab until the interview ends, as you would in a real interview. The timer kept running while you were away.
          {count > 1 ? ` You have left the interview ${count} times.` : ''}
        </p>
        <button ref={btn} className="btn primary" type="button" onClick={onDismiss}>Return to the interview</button>
      </div>
    </div>,
    document.body,
  );
}

export default function InterviewRoom({ initial }: { initial: SessionView }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { session, phase, status, streaming, error, feedback, reply, start, submit, clarify, control, clearError } = useInterviewSession(initial);
  const config = session.config;
  const [muted, setMuted] = useState(false);
  const speech = useSpeech(Boolean(config?.speakQuestions || config?.voiceAnswers) && !muted);
  const phrases = useMemo(() => [...SECURITY_PHRASES, ...(session.roleTitle ?? '').split(/[^A-Za-z0-9+#.-]+/).filter((w) => w.length > 2)], [session.roleTitle]);
  const rec = useSpeechRecognition({ phrases });
  const [voiceSettings, setVoiceSettings] = useState(false);
  const [micOff, setMicOff] = useState(false);
  const voiceMode = Boolean(config?.voiceAnswers) && rec.supported && !micOff && rec.error !== 'not-allowed';

  const [answer, setAnswer] = useState('');
  const [typing, setTyping] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [showTips, setShowTips] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [asking, setAsking] = useState(false);
  const [clarifyText, setClarifyText] = useState('');
  const [autoSubmit, setAutoSubmit] = useState(true);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [textOnly, setTextOnly] = useState(() => !hasWebGL());
  const capture = useRef<Capture>('answer');
  const typingTimer = useRef<number | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const remaining = useCountdown(session);
  const tabGuard = useTabGuard(session.id, ['asking', 'awaiting_answer', 'evaluating'].includes(session.state));
  const turn = session.currentTurn;
  const draftKey = turn ? `tr:draft:${turn.turnId}` : null;
  const canAnswer = session.state === 'awaiting_answer' && phase === 'idle' && !!turn;

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

  useEffect(() => {
    if (rec.error === 'not-allowed') toast({ tone: 'error', title: 'Microphone blocked', body: 'Allow microphone access to answer by voice, or keep typing your answers.' });
    else if (rec.error === 'network') toast({ tone: 'error', title: 'Speech recognition unavailable', body: 'Your browser could not reach its speech service. You can keep typing your answers.' });
  }, [rec.error, toast]);

  // Keep the newest exchange in view inside the transcript panel only.
  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.transcript.length]);

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

  // Voice: when the candidate stops talking, count down and submit (cancelled by speaking again).
  useEffect(() => {
    if (!voiceMode || !rec.listening || capture.current !== 'answer' || !autoSubmit) {
      setCountdown(null);
      return;
    }
    const t = setInterval(() => {
      const silent = Date.now() - rec.lastHeardAt;
      if (rec.interim || wordsIn(answer) < 8 || silent < SILENCE_MS) return setCountdown(null);
      const left = SILENCE_MS + COUNTDOWN_MS - silent;
      if (left <= 0) {
        clearInterval(t);
        setCountdown(null);
        void doSubmit(true);
      } else setCountdown(Math.ceil(left / 1000));
    }, 250);
    return () => clearInterval(t);
  }, [voiceMode, rec.listening, rec.lastHeardAt, rec.interim, answer, autoSubmit, doSubmit]);

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

  const questionText = streaming ? streaming.text : turn?.question ?? '';
  const topic = streaming?.topic ?? turn?.topic;
  const qNumber = Math.max(streaming?.questionNumber ?? session.progress.questionNumber, 1);
  const isFollowUp = (streaming?.kind ?? turn?.kind) === 'follow_up';
  const lowTime = remaining <= 120 && session.state === 'awaiting_answer';
  const speaking = phase === 'streaming' || phase === 'replying' || speech.speaking;
  const words = wordsIn(answer);
  const answeredCount = session.transcript.filter((t) => t.answer).length;
  const stageStatus = rec.listening && !speaking ? 'listening' : status;
  const stage = { status: stageStatus, speaking, speechLevel: speech.speaking ? speech.level : undefined, candidateTyping: typing || Boolean(rec.interim) };

  return (
    <div className="room page">
      <header className="room-head">
        <div className="stack" style={{ gap: 8 }}>
          <div className="eyebrow" style={{ marginBottom: 0 }}><Mic2 className="icon sm" aria-hidden /> Interview · {session.roleTitle ?? 'Role'}</div>
          <div className="row wrap tight">
            <span className={`status-pill s-${stageStatus}`} aria-live="polite">
              <span className="dot live" aria-hidden /> {STATUS_TEXT[stageStatus]}
            </span>
            {config && <span className="badge">{config.mode === 'practice' ? 'Practice mode' : 'Realistic mode'}</span>}
            {voiceMode && <span className="badge accent"><Mic className="icon sm" aria-hidden /> Voice interview</span>}
            {textOnly && <span className="badge info">Text-only mode</span>}
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
            <button className="btn icon-only" type="button" aria-pressed={!muted} aria-label={muted ? 'Unmute Alex' : 'Mute Alex'} title={muted ? 'Unmute Alex' : 'Mute Alex'} onClick={() => { if (!muted) speech.stop(); setMuted((m) => !m); }}>
              {muted ? <VolumeX className="icon" /> : <Volume2 className="icon" />}
            </button>
          )}
          {session.state === 'awaiting_answer' && (
            <button className="btn icon-only" type="button" onClick={() => { rec.stop(); speech.stop(); void control('pause'); }} disabled={phase !== 'idle'} aria-label="Pause" title="Pause">
              <Pause className="icon" />
            </button>
          )}
          {['awaiting_answer', 'paused'].includes(session.state) && (
            <button className="btn outline" type="button" onClick={() => setConfirmEnd(true)}>
              <Flag className="icon sm" aria-hidden /> End interview
            </button>
          )}
        </div>
      </header>

      {tabGuard.warning && <TabSwitchWarning count={tabGuard.count} onDismiss={tabGuard.dismiss} />}

      {confirmEnd && (
        <div className="alert warn fade-in" style={{ marginBottom: 16 }} role="alertdialog" aria-label="End interview">
          <Flag className="icon" aria-hidden />
          <div style={{ flex: 1 }}>
            <strong>End now and get your report?</strong>
            <p className="subtle" style={{ fontSize: 13.5 }}>{answeredCount} answer{answeredCount === 1 ? '' : 's'} so far. Unanswered questions are not scored.</p>
          </div>
          <button className="btn danger sm" type="button" onClick={() => { rec.stop(); speech.stop(); void control('end'); }}>End interview</button>
          <button className="btn ghost sm" type="button" onClick={() => setConfirmEnd(false)}>Keep going</button>
        </div>
      )}

      <div className="room-grid">
        <section className="stage-col" aria-label="Interviewer">
          <div className="stage-frame">
            {textOnly ? (
              <AvatarFallback status={stageStatus} speaking={speaking} candidateTyping={stage.candidateTyping} />
            ) : (
              <Suspense fallback={<AvatarFallback status={stageStatus} speaking={speaking} candidateTyping={stage.candidateTyping} />}>
                <InterviewerStage {...stage} onFallback={() => setTextOnly(true)} />
              </Suspense>
            )}
            {!textOnly && (
              <div className="stage-overlay" aria-hidden>
                <span className={`stage-chip s-${stageStatus}`}>
                  <Waveform active={speaking} /> Alex · {speaking ? 'Speaking' : STATUS_TEXT[stageStatus]}
                </span>
                {session.state !== 'planned' && <span className="stage-chip">{isFollowUp ? 'Follow-up' : `Q${qNumber}`}{topic ? ` · ${topic}` : ''}</span>}
              </div>
            )}
          </div>

          <div className={`question-card card ${phase === 'streaming' ? 'streaming' : ''}`} aria-live={phase === 'streaming' ? 'off' : 'polite'} aria-atomic="true">
            {session.state === 'planned' ? (
              <div className="ready">
                <div className="stack" style={{ gap: 6, flex: 1, minWidth: 260 }}>
                  <h2>Your interview is ready</h2>
                  <p className="subtle">
                    About {config?.durationMin} minutes. Alex's questions follow your answers, with follow-ups when useful.{' '}
                    {config?.voiceAnswers ? 'Alex will speak each question and listen for your answer; your words appear on screen so you can edit them. ' : ''}
                    The timer runs only while you are answering, and you can pause at any time.
                  </p>
                </div>
                <button className="btn primary lg" type="button" onClick={() => void start()} disabled={phase !== 'idle'}>
                  {phase === 'starting' ? <span className="spinner" /> : <><Play className="icon sm" aria-hidden /> Start interview</>}
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
                    <div className="row tight">
                      {speech.speaking ? (
                        <button className="btn ghost sm" type="button" onClick={() => { speech.stop(); listen('answer'); }}>
                          <SkipForward className="icon sm" aria-hidden /> Skip
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
          <div className={`card stack composer ${phase === 'evaluating' ? 'busy' : ''}`}>
            {error != null && <ErrorAlert error={error} onRetry={clearError} />}
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
                      {rec.listening ? <Mic className="icon lg" /> : <MicOff className="icon lg" />}
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong>{!canAnswer ? 'Wait for the question' : rec.listening ? (capture.current === 'clarify' ? 'Listening for your question' : 'Listening… speak your answer') : speech.speaking ? 'Alex is speaking' : 'Microphone paused'}</strong>
                      <p className="hint">{rec.interim ? `“${rec.interim}”` : rec.listening ? 'Your words appear below and stay editable.' : 'Tap the microphone to speak, or type below.'}</p>
                    </div>
                    {countdown != null && (
                      <button type="button" className="countdown" onClick={() => setAutoSubmit(false)} title="Keep answering">
                        Submitting in {countdown}… <span>Keep talking</span>
                      </button>
                    )}
                  </div>
                )}
                <div className="row between">
                  <label htmlFor="answer" className="field-label">Your answer</label>
                  <div className="row tight">
                    {voiceMode && (
                      <label className="hint row tight" style={{ cursor: 'pointer' }}>
                        <input type="checkbox" checked={autoSubmit} onChange={(e) => setAutoSubmit(e.target.checked)} /> Auto-submit when I stop
                      </label>
                    )}
                    <button type="button" className="btn ghost sm" onClick={() => setShowTips((v) => !v)} aria-expanded={showTips}>
                      <Lightbulb className="icon sm" aria-hidden /> Tips
                    </button>
                  </div>
                </div>
                {showTips && (
                  <div className="tips fade-in">
                    <span><b>Context</b>What was the situation or system?</span>
                    <span><b>Approach</b>What did you do, step by step?</span>
                    <span><b>Decision</b>Why that way? What trade-offs?</span>
                    <span><b>Result</b>What happened, and how did you verify it?</span>
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
                  aria-describedby="answer-help"
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
                  {!voiceMode && <span className="hint row tight" aria-hidden><span className="kbd">Ctrl</span>+<span className="kbd"><CornerDownLeft style={{ width: 11, height: 11, verticalAlign: -1 }} /></span></span>}
                  {config?.voiceAnswers && !voiceMode && (
                    <span className="hint row tight"><Keyboard className="icon sm" aria-hidden /> {rec.supported ? 'Typing mode' : 'Voice answers aren’t supported in this browser'}</span>
                  )}
                  <button className="btn primary" type="button" onClick={() => void doSubmit()} disabled={!canAnswer || !answer.trim()}>
                    {phase === 'evaluating' ? <span className="spinner" /> : <><Send className="icon sm" aria-hidden /> Submit answer</>}
                  </button>
                </div>
                {config?.voiceAnswers && rec.supported && (
                  <div className="row between hint">
                    <span>{rec.onDevice ? 'Speech is transcribed on this device.' : 'Speech is transcribed by your browser’s speech service.'}</span>
                    <div className="row tight">
                      {!micOff && (
                        <button className="btn ghost sm" type="button" aria-expanded={voiceSettings} onClick={() => setVoiceSettings((v) => !v)}>
                          <Settings2 className="icon sm" aria-hidden /> Voice settings
                        </button>
                      )}
                      <button className="btn ghost sm" type="button" onClick={() => { rec.stop(); setMicOff((m) => !m); }}>
                        {micOff ? <><Mic className="icon sm" aria-hidden /> Use voice</> : <><Keyboard className="icon sm" aria-hidden /> Type instead</>}
                      </button>
                    </div>
                  </div>
                )}
                {voiceSettings && voiceMode && (
                  <div className="voice-settings fade-in" role="group" aria-label="Voice settings">
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
                    <p className="hint">Choosing the accent closest to yours makes the biggest difference. Speak at a steady pace, close to the microphone; common security terms such as SIEM, EDR and MITRE ATT&amp;CK are corrected automatically, and you can edit the text before submitting.</p>
                  </div>
                )}
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

          <details className="card transcript" open>
            <summary>
              <h2><MessagesSquare className="icon" aria-hidden /> Transcript</h2>
              <span className="muted">{answeredCount} answered</span>
            </summary>
            <div className="chat" ref={chatRef}>
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
          </details>
        </section>
      </div>
    </div>
  );
}
