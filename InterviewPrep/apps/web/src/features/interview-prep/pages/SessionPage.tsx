import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionView } from '@threatready/contracts';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ClipboardCheck, Sparkles } from 'lucide-react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../../../lib/api';
import { Busy, CardSkeleton, ErrorAlert, focusMainHeading, isMalformedId, isNotFound, NotFoundState, usePageTitle } from '../../../ui/components';
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

/** Which screen a session state shows; focus and the tab title follow the screen, not every turn. */
function screenFor(state: string | undefined) {
  switch (state) {
    case undefined:
      return null;
    case 'parsing':
      return 'Analysing your documents';
    case 'profiled':
      return 'Configure your interview';
    case 'planned':
    case 'asking':
    case 'awaiting_answer':
    case 'evaluating':
    case 'paused':
      return 'Interview';
    case 'completed':
    case 'scoring':
      return 'Preparing your report';
    case 'report_ready':
      return 'Report';
    default:
      return 'Interview ended';
  }
}

/** An unknown, malformed or someone else's interview link. */
function SessionNotFound() {
  return (
    <NotFoundState title="This interview doesn’t exist or isn’t yours" to="/interview-prep/history" linkLabel="Go to interview history">
      The link may be mistyped or out of date. Your interviews and reports are listed in your history.
    </NotFoundState>
  );
}

export default function SessionPage() {
  const { id = '' } = useParams();
  const malformed = isMalformedId(id);
  const q = useQuery({
    queryKey: ['session', id],
    queryFn: () => api.session(id),
    enabled: !malformed,
    refetchInterval: (query) => (WORKING.has(query.state.data?.state ?? '') ? 4000 : false),
  });
  useSessionEvents(id, WORKING.has(q.data?.state ?? ''));
  const notFound = malformed || isNotFound(q.error);
  const screen = notFound ? 'Interview not found' : screenFor(q.data?.state);
  usePageTitle(screen);
  // Analysis, configure, room and report generation share one URL: announce each new screen.
  const lastScreen = useRef(screen);
  useEffect(() => {
    if (lastScreen.current && screen && lastScreen.current !== screen) focusMainHeading();
    lastScreen.current = screen;
  }, [screen]);

  if (notFound) return <SessionNotFound />;
  if (q.isPending) return <div className="page"><CardSkeleton lines={5} label="Loading your interview" /></div>;
  if (q.error) return <div className="page"><h1 className="h-sm" style={{ marginBottom: 16 }}>Your interview could not be loaded</h1><ErrorAlert error={q.error} onRetry={() => void q.refetch()} /></div>;
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
          <h1 className="h-sm">{title}</h1>
          <p className="muted" style={{ fontSize: 13.5 }}>{note}</p>
        </div>
      </div>
      <ul className="checklist">
        {steps.map((label, n) => (
          <li key={label} className={n < i ? 'done' : n === i ? 'active' : ''}>
            <span className="ck">{n < i ? <Check className="icon sm" aria-hidden /> : n === i ? <span className="spinner" aria-hidden style={{ width: 12, height: 12 }} /> : null}</span>
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

/** The retry cap: REPORT_RETRY_LIMIT_REACHED, or INTERVIEW_LIMIT_REACHED from an API that predates that code. */
const retryCapReached = (e: unknown) => e instanceof ApiError && (e.code === 'REPORT_RETRY_LIMIT_REACHED' || e.code === 'INTERVIEW_LIMIT_REACHED');

/** Retries the server still allows (`report.retriesLeft`); null when it doesn't say (older API). */
const retriesLeft = (s: SessionView) => s.report.retriesLeft ?? null;

/** The next 00:00 UTC in the learner's own clock, e.g. "5:30 am". */
const utcMidnightLocal = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function Ended({ session }: { session: SessionView }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [retrying, setRetrying] = useState(false);
  const [capped, setCapped] = useState(false);
  const failedScoring = session.state === 'failed' && session.failure?.stage === 'scoring';
  const code = session.failure?.code ?? '';
  // The platform's daily AI budget stopped the report: the server generates it once the budget resets
  // at 00:00 UTC, so a retry button could only fail until then.
  const pausedScoring = failedScoring && code === 'AI_SERVICE_PAUSED';
  // Every allowed retry is used up: no button that can only fail, and copy that says what to do instead.
  const exhausted = failedScoring && !pausedScoring && (capped || retriesLeft(session) === 0);
  const scoringFailed = failedScoring && !exhausted && !pausedScoring;
  // The analysis can fail because of the documents or because the AI service was unavailable.
  const serviceProblem = ['LLM_PROVIDER_UNAVAILABLE', 'LLM_TIMEOUT', 'LLM_OUTPUT_INVALID', 'AI_SERVICE_PAUSED', 'LLM_BUDGET_EXCEEDED'].includes(code);
  const title =
    session.state === 'failed'
      ? pausedScoring
        ? 'Your report will be generated later'
        : failedScoring
          ? 'The report could not be generated'
          : serviceProblem
            ? 'The AI service could not analyse your documents'
            : 'We could not analyse these documents'
      : session.state === 'cancelled'
        ? 'This interview was cancelled'
        : 'This interview has expired';
  const pausedBody = `Your answers are saved. Report generation is paused until 00:00 UTC (${utcMidnightLocal()} your time) because the platform’s daily AI budget is used up; the report will then be generated automatically.`;
  const body = exhausted
    ? 'Your answers are saved, but we could not generate this report after several tries. Contact support and quote the reference below, or start a new interview.'
    : scoringFailed
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
          <span className={`icon-tile ${session.state === 'failed' ? 'bad' : ''}`}>{session.state === 'failed' ? <AlertTriangle className="icon" aria-hidden /> : <Check className="icon" aria-hidden />}</span>
          <h1 className="h-sm">{title}</h1>
        </div>
        <p className="subtle">{pausedScoring ? pausedBody : body}</p>
        {session.failure && <span className="hint">Reference: {exhausted ? <><code>{session.id}</code> · </> : null}{session.failure.code}</span>}
        {error != null && <ErrorAlert error={error} />}
        <div className="row">
          {scoringFailed && (
            <button
              className="btn primary"
              type="button"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                setError(null);
                try {
                  await api.retryReport(session.id);
                  await qc.invalidateQueries({ queryKey: ['session', session.id] });
                } catch (e) {
                  // The cap: the page switches to the "contact support" copy (older APIs send the
                  // open-interview code here, whose catalogue message would be about something else).
                  if (retryCapReached(e)) setCapped(true);
                  else setError(e);
                } finally {
                  setRetrying(false);
                }
              }}
            >
              {retrying ? <Busy label="Requesting…" /> : 'Generate report again'}
            </button>
          )}
          <button className="btn" type="button" onClick={() => navigate('/interview-prep/new')}>Start a new interview</button>
          <Link className="btn ghost" to="/interview-prep">Back to dashboard</Link>
        </div>
      </div>
    </div>
  );
}
