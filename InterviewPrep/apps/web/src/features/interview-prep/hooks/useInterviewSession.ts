import { useQueryClient } from '@tanstack/react-query';
import type { InterviewerStatus, PracticeFeedback, SessionView, TurnStreamEvent } from '@threatready/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, streamTurn } from '../../../lib/api';

export interface StreamingQuestion {
  turnId: string;
  kind: 'question' | 'follow_up';
  questionNumber: number;
  topic: string;
  text: string;
}

export type Phase = 'idle' | 'starting' | 'evaluating' | 'streaming' | 'recovering' | 'replying';

const store = {
  get(key: string): string | null {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      /* private mode: fall back to an in-memory id */
    }
  },
};

/** One idempotency key per turn, stable across retries and refreshes. */
function submissionIdFor(turnId: string): string {
  const key = `tr:submission:${turnId}`;
  const existing = store.get(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  store.set(key, id);
  return id;
}

/**
 * Client controller for the interview room. The server is authoritative: every stream ends with a
 * `done` carrying the full session view, and a refresh resumes from GET /v1/interviews/{id}.
 */
export function useInterviewSession(initial: SessionView) {
  const qc = useQueryClient();
  const [session, setSession] = useState(initial);
  const [phase, setPhase] = useState<Phase>('idle');
  const [streaming, setStreaming] = useState<StreamingQuestion | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [feedback, setFeedback] = useState<{ turnId: string; feedback: PracticeFeedback } | null>(null);
  /** Alex's live reply to a clarifying question. */
  const [reply, setReply] = useState<{ question: string; text: string } | null>(null);
  const busy = useRef(false);

  const apply = useCallback(
    (s: SessionView) => {
      setSession(s);
      qc.setQueryData(['session', s.id], s);
    },
    [qc],
  );

  const onEvent = useCallback(
    (e: TurnStreamEvent) => {
      switch (e.type) {
        case 'evaluating':
          setPhase('evaluating');
          break;
        case 'feedback':
          setFeedback({ turnId: e.turnId, feedback: e.feedback });
          break;
        case 'question.start':
          setPhase('streaming');
          setStreaming({ turnId: e.turnId, kind: e.kind, questionNumber: e.questionNumber, topic: e.topic, text: '' });
          break;
        case 'question.delta':
          setStreaming((q) => (q ? { ...q, text: q.text + e.text } : q));
          break;
        case 'question.reset':
          setStreaming((q) => (q ? { ...q, text: '' } : q));
          setReply((r) => (r ? { ...r, text: '' } : r));
          break;
        case 'reply.delta':
          setReply((r) => (r ? { ...r, text: r.text + e.text } : r));
          break;
        case 'done':
          setStreaming(null);
          setReply(null);
          setPhase('idle');
          apply(e.session);
          break;
        case 'error':
          setStreaming(null);
          setReply(null);
          setPhase('idle');
          setError(new ApiError(e.code, e.message, 0, e.retryable, e.request_id));
          break;
      }
    },
    [apply],
  );

  const run = useCallback(
    async (path: string, body?: unknown) => {
      if (busy.current) return;
      busy.current = true;
      setError(null);
      try {
        await streamTurn(path, body, onEvent);
      } catch (e) {
        setStreaming(null);
        setPhase('idle');
        if (e instanceof ApiError && (e.code === 'INTERVIEW_TURN_IN_PROGRESS' || e.code === 'STREAM_INTERRUPTED' || e.code === 'NETWORK_ERROR')) {
          // The server finishes the turn on its own; pick up the stored result.
          setPhase('recovering');
          await new Promise((r) => setTimeout(r, 2500));
          try {
            apply(await api.session(session.id));
          } catch (err) {
            setError(err);
          }
          setPhase('idle');
        } else {
          setError(e);
        }
      } finally {
        busy.current = false;
      }
    },
    [onEvent, apply, session.id],
  );

  const start = useCallback(() => {
    setPhase('starting');
    return run(`/v1/interviews/${session.id}/start`);
  }, [run, session.id]);

  const submit = useCallback(
    (answer: string) => {
      const turn = session.currentTurn;
      if (!turn) return Promise.resolve();
      setFeedback(null);
      setPhase('evaluating');
      return run(`/v1/interviews/${session.id}/turns`, { turnId: turn.turnId, answer, clientSubmissionId: submissionIdFor(turn.turnId) });
    },
    [run, session],
  );

  /** Ask Alex to repeat or clarify the current question; the answer clock keeps running. */
  const clarify = useCallback(
    (message: string) => {
      const turn = session.currentTurn;
      if (!turn || !message.trim()) return Promise.resolve();
      setPhase('replying');
      setReply({ question: message.trim(), text: '' });
      return run(`/v1/interviews/${session.id}/clarify`, { turnId: turn.turnId, message: message.trim() });
    },
    [run, session],
  );

  const control = useCallback(
    async (action: 'pause' | 'resume' | 'end') => {
      setError(null);
      try {
        apply(await api[action](session.id));
      } catch (e) {
        setError(e);
      }
    },
    [apply, session.id],
  );

  // Recovery after a refresh or a dropped connection.
  useEffect(() => {
    if (busy.current || phase !== 'idle' || error) return;
    if (session.state === 'asking') {
      const t = setTimeout(() => void run(`/v1/interviews/${session.id}/question`), 1500);
      return () => clearTimeout(t);
    }
    if (session.state === 'evaluating') {
      const t = setTimeout(async () => {
        try {
          apply(await api.session(session.id));
        } catch (e) {
          setError(e);
        }
      }, 2500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [session.state, session.id, phase, error, run, apply, session]);

  const status: InterviewerStatus =
    phase === 'streaming' || phase === 'starting' || phase === 'replying'
      ? 'asking'
      : phase === 'evaluating' || phase === 'recovering'
        ? 'evaluating'
        : session.interviewerStatus;

  return { session, phase, status, streaming, error, feedback, reply, start, submit, clarify, control, clearError: () => setError(null), refresh: async () => apply(await api.session(session.id)) };
}
