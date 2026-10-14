import { useQuery } from '@tanstack/react-query';
import type { InterviewReport, QuestionReview, SkillOutcome } from '@threatready/contracts';
import {
  AlertTriangle,
  ArrowRight,
  Award,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ClipboardList,
  Download,
  FileText,
  Info,
  Lightbulb,
  ListChecks,
  Repeat,
  Scale,
  Star,
  Target,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../../../lib/api';
import { scoreTone, titleCase } from '../../../lib/format';
import { CardSkeleton, ErrorAlert, Meter, RadarChart, ScoreRing, useToast } from '../../../ui/components';

export default function ReportPage() {
  const { id = '' } = useParams();
  const q = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.report(id),
    retry: (n, e) => e instanceof ApiError && e.code === 'REPORT_NOT_READY' && n < 20,
    retryDelay: 3000,
  });

  if (q.isPending) return <div className="page"><CardSkeleton lines={8} /></div>;
  if (q.error) return <div className="page"><ErrorAlert error={q.error} onRetry={() => void q.refetch()} /></div>;
  return <Report r={q.data} />;
}

type Tab = 'overview' | 'questions' | 'plan' | 'method';

function verdict(score: number) {
  if (score >= 80) return { label: 'Strong performance', tone: 'ok' };
  if (score >= 65) return { label: 'Solid, with clear areas to sharpen', tone: 'ok' };
  if (score >= 50) return { label: 'Developing', tone: 'warn' };
  return { label: 'Needs more practice', tone: 'accent' };
}

function Report({ r }: { r: InterviewReport }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<unknown>(null);
  const toast = useToast();
  const v = verdict(r.overall.score);
  const answered = r.questions.filter((q) => q.answer).length;
  const cats = [
    { label: 'Technical', value: r.overall.technicalKnowledge },
    { label: 'Problem solving', value: r.overall.problemSolving },
    { label: 'Communication', value: r.overall.communication },
    { label: 'Role coverage', value: r.overall.roleSkillCoverage },
  ];

  async function downloadPdf() {
    setPdfBusy(true);
    setPdfError(null);
    try {
      const { url } = await api.reportPdf(r.sessionId);
      window.location.assign(url);
      toast({ tone: 'ok', title: 'Downloading your report', body: 'The link is valid for two minutes.' });
    } catch (e) {
      setPdfError(e);
    } finally {
      setPdfBusy(false);
    }
  }

  const tabs: { id: Tab; label: string; icon: typeof Star; count?: number }[] = [
    { id: 'overview', label: 'Overview', icon: Star },
    { id: 'questions', label: 'Question review', icon: ListChecks, count: r.questions.length },
    { id: 'plan', label: 'Improvement plan', icon: TrendingUp },
    { id: 'method', label: 'How it was scored', icon: Scale },
  ];

  return (
    <div className="page" style={{ maxWidth: 1180 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow"><FileText className="icon sm" aria-hidden /> Interview report</div>
          <h1>{r.roleTitle}</h1>
          <div className="row wrap tight" style={{ marginTop: 10 }}>
            <span className="badge">{titleCase(r.config.interviewType)}</span>
            <span className="badge">{titleCase(r.config.difficulty)}</span>
            <span className="badge">{r.config.durationMin} min</span>
            <span className="badge">{answered} answered</span>
            <span className="muted" style={{ fontSize: 13 }}>{new Date(r.generatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
          </div>
        </div>
        <div className="row">
          {r.pdf.available && (
            <button className="btn" type="button" onClick={() => void downloadPdf()} disabled={pdfBusy}>
              {pdfBusy ? <span className="spinner" /> : <><Download className="icon sm" aria-hidden /> Download PDF</>}
            </button>
          )}
          <Link className="btn primary" to="/interview-prep/new"><Repeat className="icon sm" aria-hidden /> Practise again</Link>
        </div>
      </div>
      {pdfError != null && <div style={{ marginBottom: 16 }}><ErrorAlert error={pdfError} /></div>}

      <section className="report-hero card fade-in" aria-label="Overall performance">
        <div className="score-block">
          <ScoreRing score={r.overall.score} size={168} />
          <span className={`badge ${v.tone}`}>{v.label}</span>
        </div>
        <div className="stack" style={{ minWidth: 0 }}>
          <h2>Overall performance</h2>
          <p className="subtle" style={{ lineHeight: 1.65 }}>{r.overall.summary}</p>
          <div className="grid cols-2" style={{ gap: 14, marginTop: 4 }}>
            {cats.map((c) => <Meter key={c.label} label={c.label} value={c.value} />)}
          </div>
        </div>
        <div className="radar-wrap">
          <RadarChart data={cats} size={260} />
        </div>
      </section>

      <div className="alert info" style={{ marginTop: 16 }}>
        <Info className="icon" aria-hidden />
        <span>{r.disclaimer}</span>
      </div>
      {r.integrityNotes.length > 0 && (
        <div className="alert warn" style={{ marginTop: 12 }}>
          <AlertTriangle className="icon" aria-hidden />
          <span>{r.integrityNotes.join(' ')}</span>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Report sections" style={{ marginTop: 26 }}>
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            <t.icon className="icon sm" aria-hidden /> {t.label} {t.count != null && <span className="count">{t.count}</span>}
          </button>
        ))}
      </div>

      <div key={tab} className="fade-in">
        {tab === 'overview' && <Overview r={r} />}
        {tab === 'questions' && (
          <div className="stack">
            {r.questions.map((q, i) => <QuestionCard key={q.turnId} q={q} defaultOpen={i === 0} />)}
          </div>
        )}
        {tab === 'plan' && <Plan r={r} />}
        {tab === 'method' && (
          <div className="card stack">
            <h3>How this report was scored</h3>
            <ul className="subtle" style={{ fontSize: 14, margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
              {r.scoringMethod.notes.map((n) => <li key={n}>{n}</li>)}
              <li>Overall = {Object.entries(r.scoringMethod.weights).map(([k, w]) => `${titleCase(k.replace(/([A-Z])/g, '_$1').toLowerCase())} ${Math.round(w * 100)}%`).join(' + ')}.</li>
              <li>All numbers are computed by ThreatReady from rubric levels; the AI model provides levels, evidence quotes and written feedback only.</li>
            </ul>
            <span className="hint">Scoring version {r.scoringMethod.version}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Overview({ r }: { r: InterviewReport }) {
  return (
    <div className="grid cols-3 stagger" style={{ alignItems: 'start' }}>
      <SkillCard icon={Award} tone="ok" title="Demonstrated skills" skills={r.skills.demonstrated} empty="No skill reached 70 in this session yet." />
      <SkillCard icon={Target} tone="warn" title="Needs improvement" skills={r.skills.needsImprovement} empty="No skill scored under 55." />
      <SkillCard icon={CircleAlert} tone="accent" title="Gaps against the job" skills={r.skills.jdGaps} empty="Every required skill was covered at a solid level." showRequired />
    </div>
  );
}

function SkillCard({ icon: Icon, tone, title, skills, empty, showRequired }: { icon: typeof Award; tone: string; title: string; skills: SkillOutcome[]; empty: string; showRequired?: boolean }) {
  return (
    <section className="card" aria-label={title}>
      <div className="card-title">
        <h3><span className={`icon-tile ${tone}`} style={{ width: 30, height: 30, borderRadius: 8 }}><Icon className="icon sm" aria-hidden /></span> {title}</h3>
        <span className="muted" style={{ fontSize: 13 }}>{skills.length}</span>
      </div>
      {skills.length === 0 ? (
        <p className="muted" style={{ fontSize: 13.5 }}>{empty}</p>
      ) : (
        <div className="stack">
          {skills.map((s) =>
            s.score == null ? (
              <div key={s.skillId} className="row between" style={{ fontSize: 14 }}>
                <span>{s.label}</span>
                <span className="badge">{showRequired && s.required ? 'Not tested' : '—'}</span>
              </div>
            ) : (
              <Meter key={s.skillId} label={s.label} value={s.score} />
            ),
          )}
        </div>
      )}
    </section>
  );
}

function Plan({ r }: { r: InterviewReport }) {
  const next = r.improvementPlan.suggestedNextInterview;
  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <div className="stack">
        <section className="card stack">
          <div className="card-title" style={{ marginBottom: 4 }}><h3><TrendingUp className="icon" aria-hidden /> Priorities</h3></div>
          {r.improvementPlan.highPriority.length === 0 && r.improvementPlan.secondary.length === 0 && <p className="muted">Nothing urgent.</p>}
          {r.improvementPlan.highPriority.map((t) => (
            <div key={t.topic} className="priority high">
              <span className="badge accent">High</span>
              <div><strong>{t.topic}</strong><p className="subtle" style={{ fontSize: 13.5 }}>{t.why}</p></div>
            </div>
          ))}
          {r.improvementPlan.secondary.map((t) => (
            <div key={t.topic} className="priority">
              <span className="badge">Next</span>
              <div><strong>{t.topic}</strong><p className="subtle" style={{ fontSize: 13.5 }}>{t.why}</p></div>
            </div>
          ))}
        </section>
        {r.skills.practiceAreas.length > 0 && (
          <section className="card stack">
            <div className="card-title" style={{ marginBottom: 4 }}><h3><BookOpen className="icon" aria-hidden /> Areas to practise</h3></div>
            <div className="row wrap tight">{r.skills.practiceAreas.map((a) => <span key={a} className="badge">{a}</span>)}</div>
          </section>
        )}
      </div>
      <div className="stack">
        <section className="card stack">
          <div className="card-title" style={{ marginBottom: 4 }}><h3><ClipboardList className="icon" aria-hidden /> Practice questions</h3></div>
          <ol className="practice-list">
            {r.improvementPlan.practiceQuestions.map((pq) => <li key={pq}>{pq}</li>)}
          </ol>
        </section>
        <section className="card accent stack">
          <div className="row">
            <span className="icon-tile accent"><Repeat className="icon" aria-hidden /></span>
            <div>
              <strong>Suggested next interview</strong>
              <p className="subtle" style={{ fontSize: 13.5 }}>
                {titleCase(next.interviewType)} · {titleCase(next.difficulty)} · {next.durationMin} minutes
              </p>
            </div>
          </div>
          {next.focus.length > 0 && <div className="row wrap tight">{next.focus.map((f) => <span key={f} className="badge accent">{f}</span>)}</div>}
          <Link className="btn primary" to="/interview-prep/new" style={{ alignSelf: 'flex-start' }}>Start it <ArrowRight className="icon sm arrow" aria-hidden /></Link>
        </section>
      </div>
    </div>
  );
}

function QuestionCard({ q, defaultOpen }: { q: QuestionReview; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const dims: [string, number | null][] = [
    ['Technical correctness', q.dimensions.technicalCorrectness],
    ['Completeness', q.dimensions.completeness],
    ['Reasoning', q.dimensions.reasoning],
    ['Communication', q.dimensions.communication],
    ['Skill evidence', q.dimensions.skillEvidence],
  ];
  const id = `q-${q.turnId}`;
  return (
    <section className={`card q-card ${open ? 'open' : ''}`}>
      <button type="button" className="q-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span className={`score-pill ${scoreTone(q.score)}`}>{q.score ?? '—'}</span>
        <span className="stack" style={{ gap: 3, flex: 1, minWidth: 0, textAlign: 'left' }}>
          <span className="muted" style={{ fontSize: 12.5 }}>{q.kind === 'follow_up' ? 'Follow-up' : `Question ${q.questionNumber}`} · {q.topic}</span>
          <span style={{ fontWeight: 550 }}>{q.question}</span>
        </span>
        <ChevronDown className="icon chev-rot" aria-hidden />
      </button>
      {open && (
        <div id={id} className="stack lg fade-in" style={{ marginTop: 18 }}>
          <div>
            <div className="field-label" style={{ marginBottom: 8 }}>Your answer</div>
            <div className="bubble you" style={{ maxWidth: '100%', animation: 'none' }}>{q.answer ?? 'Not answered'}</div>
          </div>
          {q.explanation && (
            <div className="alert">
              <Lightbulb className="icon" aria-hidden style={{ color: 'var(--warn-text)' }} />
              <span><strong>Assessment: </strong>{q.explanation}</span>
            </div>
          )}
          <div className="grid cols-2">
            <div className="stack">
              {dims.filter(([, v]) => v !== null).map(([label, v]) => <Meter key={label} label={label} value={v} thin />)}
            </div>
            <div className="stack" style={{ fontSize: 14 }}>
              {q.correctConcepts.length > 0 && <List icon={CheckCircle2} color="var(--ok-text)" title="Correct concepts" items={q.correctConcepts} />}
              {q.missingConcepts.length > 0 && <List icon={CircleAlert} color="var(--warn-text)" title="Missing details" items={q.missingConcepts} />}
              {q.inaccuracies.length > 0 && <List icon={XCircle} color="var(--accent-strong)" title="Technical inaccuracies" items={q.inaccuracies} />}
              {q.improvements.length > 0 && <List icon={TrendingUp} color="var(--info-text)" title="How to improve" items={q.improvements} />}
            </div>
          </div>
          {q.strongAnswerExample && (
            <div className="strong-answer">
              <div className="row tight" style={{ marginBottom: 6 }}><Star className="icon sm" aria-hidden /> <strong style={{ fontSize: 14 }}>Example of a strong answer</strong></div>
              <p className="subtle" style={{ fontSize: 14, lineHeight: 1.65 }}>{q.strongAnswerExample}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function List({ icon: Icon, color, title, items }: { icon: typeof Star; color: string; title: string; items: string[] }) {
  return (
    <div>
      <div className="row tight" style={{ marginBottom: 6, color }}><Icon className="icon sm" aria-hidden /> <strong style={{ fontSize: 13.5 }}>{title}</strong></div>
      <ul style={{ margin: 0, paddingLeft: 26, color: 'var(--text-2)', display: 'grid', gap: 3 }}>{items.map((i) => <li key={i}>{i}</li>)}</ul>
    </div>
  );
}
