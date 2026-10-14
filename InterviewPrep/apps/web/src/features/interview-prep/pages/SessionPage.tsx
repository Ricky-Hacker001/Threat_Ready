import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionView } from '@threatready/contracts';
import { lazy, Suspense, useEffect, useState } from 'react';
import { AlertTriangle, Check, ClipboardCheck, Sparkles } from 'lucide-react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { api } from '../../../lib/api';
import { CardSkeleton, ErrorAlert } from '../../../ui/components';
import { ConfigureView } from '../components/ConfigureView';
import { Stepper } from '../components/Stepper';

const InterviewRoom = lazy(() => import('../components/InterviewRoom'));

/** Pushes job progress (analysis, scoring) over SSE; polling remains as a fallback. */
export function useSessionEvents(id: string, active: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!active || typeof EventSource === 'undefined') return;
    const es = new EventSource(`/v1/interviews/${id}/events`, { withCredentials: true });
    es.addEventListener('state', () => void qc.invalidateQueries({ queryKey: ['session', id] }));
    es.onerror = () => es.close();
    return () => es.close();
  }, [id, active, qc]);
}

const WORKING = new Set(['parsing', 'completed', 'scoring']);

export default function SessionPage() {
  const { id = '' } = useParams();
  const q = useQuery({
    queryKey: ['session', id],
    queryFn: () => api.session(id),
    refetchInterval: (query) => (WORKING.has(query.state.data?.state ?? '') ? 4000 : false),
  });
  useSessionEvents(id, WORKING.has(q.data?.state ?? ''));

  if (q.isPending) return <div className="page"><CardSkeleton lines={5} /></div>;
  if (q.error) return <div className="page"><ErrorAlert error={q.error} onRetry={() => void q.refetch()} /></div>;
  const s = q.data;

  switch (s.state) {
    case 'parsing':
      return <Analysing />;
    case 'profiled':
      return (
        <div className="page" style={{ maxWidth: 1280 }}>
          <div className="page-head">
            <div>
              <div className="eyebrow"><Sparkles className="icon sm" aria-hidden /> New interview</div>
              <h1>Confirm the details and configure</h1>
              <p className="subtle" style={{ marginTop: 8 }}>Check what we extracted, then tune the interview. We pre-selected the best fit for this role.</p>
            </div>
          </div>
          <Stepper current={3} />
          <ConfigureView sessionId={s.id} />
        </div>
      );
    case 'planned':
    case 'asking':
    case 'awaiting_answer':
    case 'evaluating':
    case 'paused':
      return (
        <Suspense fallback={<div className="page"><CardSkeleton lines={6} /></div>}>
          <InterviewRoom initial={s} />
        </Suspense>
      );
    case 'completed':
    case 'scoring':
      return <GeneratingReport session={s} />;
    case 'report_ready':
      return <Navigate to={`/interview-prep/sessions/${s.id}/report`} replace />;
    default:
      return <Ended session={s} />;
  }
}

function WorkingCard({ icon: Icon, title, steps, intervalMs, note }: { icon: typeof Sparkles; title: string; steps: string[]; intervalMs: number; note: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => Math.min(n + 1, steps.length - 1)), intervalMs);
    return () => clearInterval(t);
  }, [steps.length, intervalMs]);
  return (
    <div className="card stack lg fade-in working-card" style={{ marginTop: 24 }} aria-live="polite" aria-busy="true">
      <div className="row">
        <span className="icon-tile accent pulse-tile"><Icon className="icon lg" aria-hidden /></span>
        <div>
          <h2>{title}</h2>
          <p className="muted" style={{ fontSize: 13.5 }}>{note}</p>
        </div>
      </div>
      <ul className="checklist">
        {steps.map((label, n) => (
          <li key={label} className={n < i ? 'done' : n === i ? 'active' : ''}>
            <span className="ck">{n < i ? <Check className="icon sm" aria-hidden /> : n === i ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null}</span>
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Analysing() {
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <Stepper current={3} />
      <WorkingCard
        icon={Sparkles}
        title="Analysing your documents"
        steps={['Reading your resume', 'Reading the job description', 'Comparing your experience with the role', 'Preparing recommendations']}
        intervalMs={4500}
        note="Usually under a minute. You can leave this page; the analysis continues and appears on your dashboard."
      />
    </div>
  );
}

function GeneratingReport({ session }: { session: SessionView }) {
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <WorkingCard
        icon={ClipboardCheck}
        title="That's the end of the interview. Thanks for your time."
        steps={['Reviewing every answer against its rubric', 'Checking evidence in your answers', 'Mapping skills to the job description', 'Writing your improvement plan']}
        intervalMs={5000}
        note={`Alex is now scoring your ${session.transcript.filter((t) => t.answer).length} answers${session.endReason === 'time_up' ? ' (time limit reached)' : ''}. Your report is saved to your history when it is ready.`}
      />
    </div>
  );
}

function Ended({ session }: { session: SessionView }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const scoringFailed = session.state === 'failed' && session.failure?.stage === 'scoring';
  const code = session.failure?.code ?? '';
  // The analysis can fail because of the documents or because the AI service was unavailable.
  const serviceProblem = ['LLM_PROVIDER_UNAVAILABLE', 'LLM_TIMEOUT', 'LLM_OUTPUT_INVALID', 'AI_SERVICE_PAUSED', 'LLM_BUDGET_EXCEEDED'].includes(code);
  const title =
    session.state === 'failed'
      ? scoringFailed
        ? 'The report could not be generated'
        : serviceProblem
          ? 'The AI service could not analyse your documents'
          : 'We could not analyse these documents'
      : session.state === 'cancelled'
        ? 'This interview was cancelled'
        : 'This interview has expired';
  const body = scoringFailed
    ? 'Your answers are saved. Generating the report again is safe and will not create duplicates.'
    : session.state !== 'failed'
      ? 'Start a new interview whenever you are ready.'
      : code === 'LLM_BUDGET_EXCEEDED'
        ? 'You have reached today’s AI usage limit. Try again tomorrow; this attempt does not count toward your monthly quota.'
        : code === 'AI_SERVICE_PAUSED'
          ? 'New interviews are paused for today. Try again tomorrow; this attempt does not count toward your monthly quota.'
          : serviceProblem
            ? 'Your documents are fine. The AI service was unavailable, so nothing was analysed. Start a new interview to try again; this attempt does not count toward your monthly quota.'
            : 'Check that the resume and job description contain readable text, then start a new interview.';
  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="card stack lg">
        <div className="row">
          <span className={`icon-tile ${session.state === 'failed' ? 'accent' : ''}`}>{session.state === 'failed' ? <AlertTriangle className="icon" aria-hidden /> : <Check className="icon" aria-hidden />}</span>
          <h2>{title}</h2>
        </div>
        <p className="subtle">{body}</p>
        {session.failure && <span className="hint">Reference: {session.failure.code}</span>}
        {error != null && <ErrorAlert error={error} />}
        <div className="row">
          {scoringFailed && (
            <button
              className="btn primary"
              type="button"
              onClick={async () => {
                try {
                  await api.retryReport(session.id);
                  await qc.invalidateQueries({ queryKey: ['session', session.id] });
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Generate report again
            </button>
          )}
          <button className="btn" type="button" onClick={() => navigate('/interview-prep/new')}>Start a new interview</button>
          <Link className="btn ghost" to="/interview-prep">Back to dashboard</Link>
        </div>
      </div>
    </div>
  );
}
