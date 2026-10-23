import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Award,
  BrainCircuit,
  CalendarDays,
  ChevronRight,
  ClipboardCheck,
  FileText,
  Gauge,
  MessagesSquare,
  PlayCircle,
  Sparkles,
  Target,
  TrendingUp,
  Upload,
} from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router';
import { useMe } from '../../../lib/auth';
import { api } from '../../../lib/api';
import { relativeTime, STATE_LABEL } from '../../../lib/format';
import { CardSkeleton, CountUp, Empty, ErrorAlert, Meter, ScorePill, Skeleton, Sparkline, usePageTitle } from '../../../ui/components';
import { AvatarFallback } from '../avatar/AvatarFallback';
import { hasWebGL } from '../avatar/webgl';

const InterviewerStage = lazy(() => import('../avatar/InterviewerStage'));

/** Screen A. Every number shown here comes from persisted sessions and evaluations. */
export default function DashboardPage() {
  usePageTitle('Dashboard');
  const q = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard });
  const { data: me } = useMe();
  const d = q.data;
  const firstName = me?.name.split(/\s+/)[0] ?? 'there';
  const isNew = d ? d.recent.length === 0 : false;
  const trend = d && d.scoreHistory.length >= 2 ? d.scoreHistory[d.scoreHistory.length - 1]!.score - d.scoreHistory[d.scoreHistory.length - 2]!.score : null;

  return (
    <div className="page">
      <Hero firstName={firstName} returning={Boolean(d && (d.recent.length > 0 || d.completedCount > 0))} />

      {q.error && <div style={{ marginTop: 20 }}><ErrorAlert error={q.error} onRetry={() => void q.refetch()} /></div>}

      {d && d.resumable.length > 0 && (
        <section className="card accent fade-in" style={{ marginTop: 22 }} aria-label="Continue interview">
          <div className="list">
            {d.resumable.map((s) => (
              <div className="list-item" key={s.id}>
                <span className="icon-tile accent"><PlayCircle className="icon" aria-hidden /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{s.roleTitle ?? 'Interview in preparation'}</strong>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {STATE_LABEL[s.state as keyof typeof STATE_LABEL]?.label ?? s.state} · updated {relativeTime(s.updatedAt)}
                  </div>
                </div>
                <Link className="btn primary sm" to={`/interview-prep/sessions/${s.id}`}>
                  Continue interview <ArrowRight className="icon sm arrow" aria-hidden />
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="grid cols-4 stagger" style={{ marginTop: 22 }} aria-label="Summary">
        {q.isPending
          ? Array.from({ length: 4 }, (_, i) => (
              <div className="card" key={i}>
                <Skeleton h={38} w={38} />
                <Skeleton h={28} w="40%" style={{ marginTop: 14 }} />
                <Skeleton h={12} w="60%" style={{ marginTop: 10 }} />
              </div>
            ))
          : d && (
              <>
                <Kpi icon={ClipboardCheck} tone="ok" label="Completed interviews" value={<CountUp value={d.completedCount} />} note="Scored reports in your history" />
                <Kpi
                  icon={Gauge}
                  tone="accent"
                  label="Average score"
                  value={d.averageScore == null ? '—' : <CountUp value={d.averageScore} suffix={<small>/100</small>} />}
                  note={
                    trend == null ? (
                      d.averageScore == null ? 'Shown after your first report' : 'Across all reports'
                    ) : (
                      <>
                        <TrendingUp className="icon sm" aria-hidden style={{ color: trend >= 0 ? 'var(--ok-text)' : 'var(--bad-text)', transform: trend < 0 ? 'scaleY(-1)' : undefined }} />
                        {trend >= 0 ? '+' : ''}
                        {trend} since last interview
                      </>
                    )
                  }
                  extra={d.scoreHistory.length > 1 ? <Sparkline values={d.scoreHistory.map((h) => h.score)} width={120} height={36} /> : null}
                />
                <Kpi icon={Award} tone="info" label="Skills demonstrated" value={<CountUp value={d.skillsDemonstrated.length} />} note="Skills scoring 70 or above" />
                <Kpi
                  icon={CalendarDays}
                  tone="warn"
                  label="Interviews this month"
                  value={
                    <>
                      <CountUp value={d.usage.interviewsThisMonth} />
                      <small>/{d.usage.monthlyQuota}</small>
                    </>
                  }
                  note={`${Math.max(0, d.usage.monthlyQuota - d.usage.interviewsThisMonth)} remaining on your plan`}
                />
              </>
            )}
      </section>

      {isNew && <HowItWorks />}

      <div className="grid cols-3" style={{ marginTop: 22, alignItems: 'start' }}>
        <section className="card" style={{ gridColumn: 'span 2' }} aria-label="Recent interviews">
          <div className="card-title">
            <h2><MessagesSquare className="icon" aria-hidden /> Recent interviews</h2>
            <Link to="/interview-prep/history" className="btn ghost sm">View all <ChevronRight className="icon sm" aria-hidden /></Link>
          </div>
          {q.isPending ? (
            <CardSkeleton lines={4} />
          ) : !d || d.recent.length === 0 ? (
            <Empty icon={Sparkles} title="No interviews yet" action={<Link to="/interview-prep/new" className="btn primary">Start your first interview <ArrowRight className="icon sm arrow" /></Link>}>
              Upload your resume and a job description. We build a personalised interview and score it against a rubric.
            </Empty>
          ) : (
            <div className="list">
              {d.recent.map((s) => {
                const st = STATE_LABEL[s.state as keyof typeof STATE_LABEL];
                const href = s.state === 'report_ready' ? `/interview-prep/sessions/${s.id}/report` : `/interview-prep/sessions/${s.id}`;
                return (
                  <Link to={href} className="list-item" key={s.id}>
                    <span className="icon-tile">{s.state === 'report_ready' ? <FileText className="icon" aria-hidden /> : <BrainCircuit className="icon" aria-hidden />}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.roleTitle ?? 'Analysing documents…'}</strong>
                      <span className="muted" style={{ fontSize: 13 }}>{relativeTime(s.createdAt)}</span>
                    </div>
                    <span className={`badge ${st?.tone ?? ''}`}>{st?.label ?? s.state}</span>
                    <ScorePill score={s.overallScore} />
                    <ChevronRight className="icon sm chev" aria-hidden />
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        <SkillsPanel loading={q.isPending} strengths={d?.skillsDemonstrated ?? []} improve={d?.skillsToImprove ?? []} />
      </div>
    </div>
  );
}

function Hero({ firstName, returning }: { firstName: string; returning: boolean }) {
  const [webgl] = useState(() => hasWebGL());
  return (
    <section className="hero fade-in" aria-label="InterviewPrep">
      <div className="hero-copy">
        <div className="eyebrow"><Sparkles className="icon sm" aria-hidden /> InterviewPrep</div>
        <h1>{returning ? `Welcome back, ${firstName}. Ready for your next interview?` : `Welcome, ${firstName}. Ready for your first interview?`}</h1>
        <p>Mock interviews built from your resume and the job you want. Alex asks questions, adapts to your answers and scores you against a rubric.</p>
        <div className="row wrap" style={{ marginTop: 4 }}>
          <Link to="/interview-prep/new" className="btn primary lg">
            Start new interview <ArrowRight className="icon sm arrow" aria-hidden />
          </Link>
          <Link to="/interview-prep/history" className="btn lg outline">Past reports</Link>
        </div>
        <div className="hero-features">
          <span><Target className="icon sm" aria-hidden /> Personalised to your resume</span>
          <span><BrainCircuit className="icon sm" aria-hidden /> Adaptive follow-ups</span>
          <span><ClipboardCheck className="icon sm" aria-hidden /> Rubric-based report</span>
        </div>
      </div>
      <div className="hero-art" aria-hidden>
        <div className="stage-mini">
          {webgl ? (
            <Suspense fallback={<AvatarFallback status="listening" />}>
              <InterviewerStage status="listening" speaking={false} />
            </Suspense>
          ) : (
            <AvatarFallback status="listening" />
          )}
        </div>
      </div>
    </section>
  );
}

function Kpi({ icon: Icon, tone, label, value, note, extra }: { icon: typeof Award; tone: string; label: string; value: React.ReactNode; note?: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className="card kpi">
      <div className="kpi-top">
        <span className={`icon-tile ${tone}`}><Icon className="icon" aria-hidden /></span>
        {extra}
      </div>
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
      {note && <div className="kpi-note">{note}</div>}
    </div>
  );
}

function HowItWorks() {
  const steps = [
    { icon: Upload, title: 'Upload your resume', text: 'PDF or DOCX. Contact details are removed before analysis.' },
    { icon: FileText, title: 'Add the job description', text: 'Paste it or upload it. We extract skills, level and responsibilities.' },
    { icon: MessagesSquare, title: 'Interview with Alex', text: 'Answer out loud or by typing. Questions adapt to what you say.' },
    { icon: ClipboardCheck, title: 'Get your report', text: 'Scores, gaps against the role and a practice plan.' },
  ];
  return (
    <section style={{ marginTop: 22 }} aria-label="How it works">
      <div className="how stagger">
        {steps.map((s, i) => (
          <div className="how-step" key={s.title}>
            <span className="num">0{i + 1}</span>
            <span className="icon-tile accent"><s.icon className="icon" aria-hidden /></span>
            <strong>{s.title}</strong>
            <p>{s.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SkillsPanel({ loading, strengths, improve }: { loading: boolean; strengths: { skillId: string; label: string; score: number }[]; improve: { skillId: string; label: string; score: number }[] }) {
  const [tab, setTab] = useState<'strengths' | 'improve'>('strengths');
  const list = tab === 'strengths' ? strengths : improve;
  return (
    <section className="card" aria-label="Skills">
      <div className="card-title">
        <h2><Award className="icon" aria-hidden /> Skills</h2>
      </div>
      <div className="segmented" role="group" aria-label="Show skills" style={{ marginBottom: 16, width: '100%' }}>
        <button type="button" aria-pressed={tab === 'strengths'} style={{ flex: 1 }} onClick={() => setTab('strengths')}>
          Demonstrated <span className="muted">{strengths.length}</span>
        </button>
        <button type="button" aria-pressed={tab === 'improve'} style={{ flex: 1 }} onClick={() => setTab('improve')}>
          To improve <span className="muted">{improve.length}</span>
        </button>
      </div>
      {loading ? (
        <CardSkeleton lines={3} />
      ) : list.length === 0 ? (
        <p className="muted" style={{ fontSize: 13.5 }}>
          {tab === 'strengths' ? 'Skills scoring 70 or above appear here after a report.' : 'Skills scoring under 55 appear here, with practice suggestions in each report.'}
        </p>
      ) : (
        <div className="stack" key={tab}>
          {list.map((s) => (
            <Meter key={s.skillId} label={s.label} value={s.score} />
          ))}
        </div>
      )}
    </section>
  );
}
