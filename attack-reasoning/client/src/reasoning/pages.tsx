import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, BASE } from '../api';
import { ArchitectureDiagram } from './Diagram';
import { DIMENSION_SHORT, DOMAIN_SLUG, FAILURE_MESSAGE, messageFor, reasoning, type AttemptSummary, type AttemptView, type Dashboard, type DomainView, type OptionId, type Result } from './api';

const MIN_JUSTIFICATION = 40;
const MAX_JUSTIFICATION = 4000;
const TRANSIENT = new Set(['generating', 'evaluating']);
const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`.replace(/\./g, '-'));

const STATE_TAG: Record<string, { label: string; cls: string }> = {
  generating: { label: 'Generating', cls: 'tr-tag-info' },
  ready: { label: 'Ready', cls: 'tr-tag-accent' },
  evaluating: { label: 'Evaluating', cls: 'tr-tag-info' },
  evaluated: { label: 'Evaluated', cls: 'tr-tag-live' },
  generation_failed: { label: 'Generation failed', cls: 'tr-tag-soon' },
  evaluation_failed: { label: 'Evaluation failed', cls: 'tr-tag-soon' },
};
const StateTag = ({ state }: { state: string }) => { const t = STATE_TAG[state] ?? { label: state, cls: 'tr-tag-plain' }; return <span className={`tr-tag ${t.cls}`}>{t.label}</span>; };

function Crumbs({ items }: { items: { label: string; to?: string; go?: (to: string) => void }[] }) {
  return <nav className="ar-crumbs" aria-label="Breadcrumb">{items.map((c, i) => <span key={i} className="ar-crumb">{i > 0 && <span aria-hidden="true">/</span>}{c.to && c.go ? <a href={c.to} onClick={(e) => { e.preventDefault(); c.go!(c.to!); }}>{c.label}</a> : <span>{c.label}</span>}</span>)}</nav>;
}

function Err({ e, onRetry }: { e: unknown; onRetry?: () => void }) {
  return <div className="tr-note tr-note-bad" role="alert">{messageFor(e)} {onRetry && <button className="tr-btn tr-btn-secondary tr-btn-sm" onClick={onRetry}>Retry</button>}</div>;
}
const Loading = ({ text }: { text: string }) => <div className="tr-note"><span className="tr-spinner" aria-hidden="true" />{text}</div>;

/* ---------------- Domains landing ---------------- */

export function DomainsPage({ go }: { go: (to: string) => void }) {
  const [domains, setDomains] = useState<DomainView[] | null>(null);
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = useCallback(() => { setErr(null); Promise.all([reasoning.domains(), reasoning.dashboard()]).then(([d, s]) => { setDomains(d); setDash(s); }, (e) => { if (!(e instanceof ApiError && e.status === 401)) setErr(e); }); }, []);
  useEffect(load, [load]);
  const live = domains?.filter((d) => d.available) ?? [];
  return <>
    <section className="tr-page-head"><div className="tr-wrap tr-page-head-in">
      <div>
        <span className="tr-eyebrow"><span className="tr-dot tr-dot-reasoning" aria-hidden="true" style={{ marginRight: 8 }} />Attack Reasoning Lab</span>
        <h1 className="tr-h1">Think like a defender under pressure.</h1>
        <p className="tr-lead">A generated architecture with an active attack, one decision to make, and your reasoning graded against a rubric. The score weighs <em>why</em> you chose as much as <em>what</em> you chose.</p>
      </div>
      {domains && <div className="tr-meta"><span><b className="tr-h3">{domains.length}</b>&nbsp;domains</span><span><b className="tr-h3">{live.length}</b>&nbsp;available now</span>{dash && dash.evaluated > 0 && <span><b className="tr-h3">{dash.averageScore ?? '—'}</b>&nbsp;avg score</span>}</div>}
    </div></section>
    <div className="tr-wrap tr-section">
      {err ? <Err e={err} onRetry={load} /> : null}
      {!domains && !err && <Loading text="Loading domains…" />}
      {dash && dash.attempts > 0 && <div className="tr-strip ar-strip-row"><div><b>Your progress:</b> {dash.evaluated} evaluated, {dash.inProgress} in progress{dash.bestScore !== null && <>, best {dash.bestScore}/100</>}.</div><a className="ar-link" href={`${BASE}history`} onClick={(e) => { e.preventDefault(); go(`${BASE}history`); }}>History and analytics →</a></div>}
      {domains && <>
        <h2 className="tr-section-title">Domains</h2>
        <ul className="tr-grid">{domains.map((d) => <li key={d.key} className={`tr-card ar-card ${d.available ? '' : 'is-soon'}`}>
          <div className="tr-card-top"><span className="tr-eyebrow" style={{ margin: 0 }}>{d.track}</span>{d.available ? <span className="tr-tag tr-tag-live">Live</span> : <span className="tr-tag tr-tag-soon">Coming soon</span>}</div>
          <h3 className="tr-h3">{d.available ? <a className="ar-card-link" href={`${BASE}domains/${DOMAIN_SLUG(d.key)}`} onClick={(e) => { e.preventDefault(); go(`${BASE}domains/${DOMAIN_SLUG(d.key)}`); }}>{d.title}</a> : d.title}</h3>
          <p>{d.description}</p>
          <div className="tr-card-foot"><span className="tr-mono">{d.stats.attempts ? `${d.stats.evaluated} evaluated · avg ${d.stats.averageScore ?? '—'}` : d.available ? `${cap(d.difficulty ?? '')} · AI-generated` : 'Roadmap'}</span>{d.available && <span className="ar-more" aria-hidden="true">Start →</span>}</div>
        </li>)}</ul>
        <h2 className="tr-section-title">How an assessment works</h2>
        <div className="ar-facts">
          <div className="tr-card"><span className="tr-eyebrow">1 · Scenario</span><p>The AI builds a unique architecture, attack narrative and diagram for you. It is validated in code and checked against what you have seen before, so questions do not repeat.</p></div>
          <div className="tr-card"><span className="tr-eyebrow">2 · Decision and reasoning</span><p>Pick one of four options, then explain why: the evidence, the attack path, the trade-offs. You must reason before you see the answer.</p></div>
          <div className="tr-card"><span className="tr-eyebrow">3 · Three-stage evaluation</span><p>An evaluator, an adversarial challenger and a reconciler grade your justification against a scenario-specific rubric. The score itself is computed in code from fixed weights.</p></div>
        </div>
      </>}
    </div>
  </>;
}

/* ---------------- Domain page ---------------- */

export function DomainPage({ slug, go }: { slug: string; go: (to: string) => void }) {
  const key = slug.replace(/-/g, '_');
  const [domain, setDomain] = useState<DomainView | null | undefined>(undefined);
  const [history, setHistory] = useState<AttemptSummary[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const load = useCallback(() => { setErr(null); Promise.all([reasoning.domains(), reasoning.list()]).then(([ds, l]) => { setDomain(ds.find((d) => d.key === key) ?? null); setHistory(l.items.filter((a) => a.domain === key)); }, (e) => { if (!(e instanceof ApiError && e.status === 401)) setErr(e); }); }, [key]);
  useEffect(load, [load]);
  const start = async () => { setStarting(true); setErr(null); try { const a = await reasoning.create(key); go(`${BASE}attempts/${a.id}`); } catch (e) { setErr(e); setStarting(false); } };
  const open = history.find((a) => TRANSIENT.has(a.state) || a.state === 'ready');
  return <>
    <section className="tr-page-head"><div className="tr-wrap">
      <Crumbs items={[{ label: 'All domains', to: BASE, go }, { label: domain?.title ?? cap(key.replace(/_/g, ' ')) }]} />
      {domain && <div className="tr-page-head-in">
        <div><span className="tr-eyebrow">{domain.track} · {cap(domain.difficulty ?? '')}</span><h1 className="tr-h1">{domain.title}</h1><p className="tr-lead">{domain.description}</p></div>
        <div className="ar-start">
          {open ? <>
            <button type="button" className="tr-btn tr-btn-primary" onClick={() => go(`${BASE}attempts/${open.id}`)}>Continue assessment</button>
            <span className="tr-small tr-muted">You have an assessment in progress.</span>
          </> : <>
            <button type="button" className="tr-btn tr-btn-primary" disabled={starting} onClick={start}>{starting ? 'Starting…' : 'Start assessment'}</button>
            <span className="tr-small tr-muted">One generated scenario, one decision, your reasoning. About 10 minutes.</span>
          </>}
        </div>
      </div>}
    </div></section>
    <div className="tr-wrap tr-section">
      {err ? <Err e={err} onRetry={load} /> : null}
      {domain === undefined && !err && <Loading text="Loading domain…" />}
      {domain === null && <div className="tr-note tr-note-bad" role="alert">That domain does not exist. <button className="tr-btn tr-btn-secondary tr-btn-sm" onClick={() => go(BASE)}>All domains</button></div>}
      {domain && <div className="ar-detail-grid">
        <div className="ar-main">
          <section className="tr-card"><h2 className="tr-h3">What this domain assesses</h2><ul className="ar-list">{domain.focus.map((f) => <li key={f}>{f}</li>)}</ul></section>
          <section className="tr-card"><h2 className="tr-h3">Your attempts</h2>
            {history.length === 0 ? <p className="tr-muted">No attempts yet. Your first scenario is generated when you start.</p> : <table className="ar-table"><thead><tr><th>Scenario</th><th>State</th><th>Score</th><th>When</th></tr></thead><tbody>{history.map((a) => <tr key={a.id}><td><a className="ar-link" href={`${BASE}attempts/${a.id}`} onClick={(e) => { e.preventDefault(); go(`${BASE}attempts/${a.id}`); }}>{a.title ?? 'Scenario'}</a></td><td><StateTag state={a.state} /></td><td className="tr-mono">{a.totalScore ?? '—'}{a.correct !== null && <span className="tr-small tr-muted"> {a.correct ? '· correct' : '· incorrect'}</span>}</td><td className="tr-small">{fmtDate(a.createdAt)}</td></tr>)}</tbody></table>}
          </section>
        </div>
        <aside className="ar-side">
          <section className="tr-card"><h2 className="tr-h3">Scoring</h2>
            {domain.weights && <table className="ar-table"><tbody>{(Object.keys(domain.weights) as (keyof typeof domain.weights)[]).map((k) => <tr key={k}><td>{DIMENSION_SHORT[k]}</td><td className="tr-mono">{domain.weights![k]} pts</td></tr>)}</tbody></table>}
            <p className="tr-small">A correct guess with weak reasoning scores low; a wrong decision with sound architecture analysis still earns partial credit on reasoning dimensions.</p></section>
          <section className="tr-card"><h2 className="tr-h3">Techniques in play</h2><div className="tr-chips">{domain.techniques.map((t) => <span key={t.id} className="tr-chip" title={t.name}>{t.id}</span>)}</div></section>
          {domain.stats.attempts > 0 && <section className="tr-card"><h2 className="tr-h3">Your stats</h2><ul className="ar-list"><li>{domain.stats.evaluated} evaluated of {domain.stats.attempts}</li><li>Average {domain.stats.averageScore ?? '—'}, best {domain.stats.bestScore ?? '—'}</li></ul></section>}
        </aside>
      </div>}
    </div>
  </>;
}

/* ---------------- Attempt page ---------------- */

function useAttempt(id: string) {
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const timer = useRef<number | null>(null);
  const refresh = useCallback(async () => { try { const a = await reasoning.get(id); setAttempt(a); setErr(null); return a; } catch (e) { if (!(e instanceof ApiError && e.status === 401)) setErr(e); return null; } }, [id]);
  useEffect(() => {
    let on = true;
    const tick = async () => { const a = await refresh(); if (on && a && TRANSIENT.has(a.state)) timer.current = window.setTimeout(tick, 2500); };
    tick();
    return () => { on = false; if (timer.current) window.clearTimeout(timer.current); };
  }, [refresh]);
  return { attempt, err, refresh, setAttempt };
}

export function AttemptPage({ id, go }: { id: string; go: (to: string) => void }) {
  const { attempt, err, refresh, setAttempt } = useAttempt(id);
  const [selected, setSelected] = useState<OptionId | null>(null);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [subErr, setSubErr] = useState<unknown>(null);
  const [result, setResult] = useState<Result | null>(null);
  const submissionId = useRef(uuid());
  const [slow, setSlow] = useState(false);
  const state = attempt?.state;
  useEffect(() => { setSlow(false); if (state && TRANSIENT.has(state)) { const t = window.setTimeout(() => setSlow(true), 75_000); return () => window.clearTimeout(t); } return undefined; }, [state]);
  useEffect(() => { if (state === 'evaluated' && !result) reasoning.result(id).then(setResult, setSubErr); }, [state, id, result]);
  // While a transient state lasts, keep polling even after a submit from this page.
  useEffect(() => { if (state && TRANSIENT.has(state)) { const t = window.setInterval(() => { refresh(); }, 2500); return () => window.clearInterval(t); } return undefined; }, [state, refresh]);
  const domainSlug = attempt ? DOMAIN_SLUG(attempt.domain) : '';
  const crumbs = [{ label: 'All domains', to: BASE, go }, { label: attempt ? cap(attempt.domain.replace(/_/g, ' ')) : 'Domain', to: attempt ? `${BASE}domains/${domainSlug}` : undefined, go }, { label: attempt?.item?.title ?? 'Assessment' }];

  const submit = async () => {
    if (!attempt || !selected) return;
    setSubmitting(true); setSubErr(null);
    try { const a = await reasoning.submit(attempt.id, selected, text.trim(), submissionId.current); setAttempt(a); }
    catch (e) { setSubErr(e); }
    finally { setSubmitting(false); }
  };
  const retry = async () => { if (!attempt) return; setSubErr(null); try { const a = await reasoning.retry(attempt.id); setAttempt(a); } catch (e) { setSubErr(e); } };
  const chars = text.trim().length;
  const canSubmit = Boolean(selected) && chars >= MIN_JUSTIFICATION && chars <= MAX_JUSTIFICATION && !submitting;

  return <>
    <section className="tr-page-head"><div className="tr-wrap"><Crumbs items={crumbs} />
      {attempt && <div className="tr-page-head-in"><div>
        <span className="tr-eyebrow">{cap(attempt.domain.replace(/_/g, ' '))}{attempt.item && <> · {cap(attempt.item.difficulty)}</>} · <StateTag state={attempt.state} /></span>
        <h1 className="tr-h1">{attempt.item?.title ?? (attempt.state === 'generating' ? 'Building your scenario' : 'Assessment')}</h1>
        {attempt.item && <p className="tr-lead">{attempt.item.objective}</p>}
      </div></div>}
    </div></section>
    <div className="tr-wrap tr-section">
      {err ? <Err e={err} onRetry={refresh} /> : null}
      {!attempt && !err && <Loading text="Loading assessment…" />}
      {attempt?.state === 'generating' && <div className="tr-card ar-wait">
        <span className="tr-spinner" aria-hidden="true" />
        <div><h2 className="tr-h3">Generating a unique scenario</h2><p>The AI is building an architecture, an attack narrative and a diagram for you. Each item is validated in code and checked against your previous questions before you see it.</p><p className="tr-small tr-muted">{slow ? 'This is taking longer than usual. The attempt is saved; you can leave this page and come back.' : 'Usually under a minute.'}</p></div>
      </div>}
      {attempt && (attempt.state === 'generation_failed' || attempt.state === 'evaluation_failed') && <div className="tr-note tr-note-bad" role="alert">
        <b>{attempt.state === 'generation_failed' ? 'Scenario generation failed.' : 'Evaluation failed.'}</b> {FAILURE_MESSAGE(attempt.failure?.code ?? '')} {attempt.state === 'evaluation_failed' && 'Your answer is saved.'} <button className="tr-btn tr-btn-secondary tr-btn-sm" onClick={retry}>Retry</button>
      </div>}
      {subErr ? <Err e={subErr} /> : null}
      {attempt?.item && (attempt.state === 'ready' || attempt.state === 'evaluating' || attempt.state === 'evaluation_failed' || attempt.state === 'evaluated') && <div className="ar-assess">
        <section className="tr-card"><h2 className="tr-h3">The environment</h2><p className="ar-prose">{attempt.item.scenario}</p></section>
        <section className="tr-card"><h2 className="tr-h3">What happened</h2><p className="ar-prose">{attempt.item.attackNarrative}</p>
          <div className="tr-chips">{attempt.item.techniques.map((t) => <span key={t.id} className="tr-chip" title={t.name}>{t.id} · {t.name}</span>)}</div></section>
        <section className="tr-card"><h2 className="tr-h3">Architecture and attack path</h2><ArchitectureDiagram diagram={attempt.item.diagram} /></section>
        {attempt.state === 'ready' ? (
          <section className="tr-card ar-question">
            <span className="tr-eyebrow">Your decision</span>
            <h2 className="tr-h2">{attempt.item.question}</h2>
            <div className="ar-options" role="radiogroup" aria-label="Options">{attempt.item.options.map((o) => <label key={o.id} className={`ar-option ${selected === o.id ? 'is-selected' : ''}`}><input type="radio" name="option" value={o.id} checked={selected === o.id} onChange={() => setSelected(o.id)} /><b className="ar-option-id">{o.id}</b><span>{o.text}</span></label>)}</div>
            <label className="ar-just"><span className="tr-eyebrow">Why this option?</span>
              <span className="tr-small tr-muted">State the evidence from the scenario and the diagram, the attack path you are breaking or tracing, the trade-offs, and why the alternatives are weaker. The evaluation grades this text; a correct guess without reasoning scores low.</span>
              <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, MAX_JUSTIFICATION))} rows={9} placeholder="The attacker is operating as … because the audit log shows … Revoking … breaks the path at … while … The alternatives …" />
              <span className="ar-counter tr-small tr-muted">{chars < MIN_JUSTIFICATION ? `${MIN_JUSTIFICATION - chars} more characters needed` : `${chars.toLocaleString()} / ${MAX_JUSTIFICATION.toLocaleString()}`}</span>
            </label>
            <div className="ar-submit"><button type="button" className="tr-btn tr-btn-primary" disabled={!canSubmit} onClick={submit}>{submitting ? 'Submitting…' : 'Submit for evaluation'}</button><span className="tr-small tr-muted">You see the correct answer and the feedback after your reasoning is evaluated.</span></div>
          </section>
        ) : (
          <section className="tr-card ar-question">
            <span className="tr-eyebrow">Your decision</span>
            <h2 className="tr-h2">{attempt.item.question}</h2>
            {attempt.answer && <div className="ar-answer"><p><b>Option {attempt.answer.selectedOption}.</b> {attempt.item.options.find((o) => o.id === attempt.answer!.selectedOption)?.text}</p><blockquote className="ar-quote">{attempt.answer.justification}</blockquote><span className="tr-small tr-muted">Submitted {fmtDate(attempt.answer.submittedAt)}</span></div>}
            {attempt.state === 'evaluating' && <div className="ar-wait ar-wait-inline"><span className="tr-spinner" aria-hidden="true" /><div><b>Evaluating in three stages</b><ol className="ar-stages"><li>Evaluator: grades your justification against the rubric with verbatim evidence</li><li>Challenger: looks for errors, invented references and over-credit</li><li>Reconciler: settles the disagreements and writes your feedback</li></ol><span className="tr-small tr-muted">{slow ? 'Taking longer than usual. Your answer is saved; you can come back later.' : 'Usually one to two minutes.'}</span></div></div>}
          </section>
        )}
        {attempt.state === 'evaluated' && (result ? <ResultView r={result} item={attempt.item} go={go} domainSlug={domainSlug} /> : !subErr && <Loading text="Loading your result…" />)}
      </div>}
    </div>
  </>;
}

/* ---------------- Result ---------------- */

const CONF: Record<string, string> = { high: 'tr-tag-live', medium: 'tr-tag-info', low: 'tr-tag-soon' };

function ResultView({ r, item, go, domainSlug }: { r: Result; item: NonNullable<AttemptView['item']>; go: (to: string) => void; domainSlug: string }) {
  const opt = (id: OptionId) => r.options.find((o) => o.id === id)!;
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<unknown>(null);
  return <div className="ar-result">
    <section className="tr-card ar-score-card">
      <div className="ar-score"><span className="ar-score-num">{r.totalScore}</span><span className="ar-score-den">/ 100</span></div>
      <div className="ar-score-side">
        <h2 className="tr-h2">{r.correct ? 'Correct decision' : 'Not the best decision'}</h2>
        <p>{r.feedback.decision}</p>
        <div className="tr-chips"><span className={`tr-tag ${CONF[r.confidence]}`}>Confidence: {r.confidence}</span>{r.reviewFlag && <span className="tr-tag tr-tag-soon">Flagged for review</span>}{r.degraded && <span className="tr-tag tr-tag-soon">Simplified scoring</span>}</div>
        {r.notices.map((n) => <p key={n} className="tr-small tr-muted">{n}</p>)}
      </div>
    </section>
    <section className="tr-card"><h2 className="tr-h3">Score breakdown</h2>
      <div className="ar-dims">{r.dimensions.map((d) => <div key={d.key} className="ar-dim">
        <div className="ar-dim-head"><span>{d.label}</span><span className="tr-mono">{d.score} / {d.weight}</span></div>
        <div className="tr-progress" aria-hidden="true"><span style={{ width: `${d.weight ? (d.score / d.weight) * 100 : 0}%` }} /></div>
        {d.notes.map((n) => <p key={n} className="tr-small tr-muted">{n}</p>)}
        {d.evidence.length > 0 && <ul className="ar-evidence">{d.evidence.map((e, i) => <li key={i} className={`is-${e.status}`}><b className="ar-ev-status">{e.status}</b><span><span className="ar-ev-point">{e.point}</span><span className="tr-small">{e.rationale}</span>{e.quote && <q className="tr-small">{e.quote}</q>}</span></li>)}</ul>}
      </div>)}</div>
      {r.scoring.notes.length > 0 && <ul className="ar-list tr-small">{r.scoring.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <p className="tr-small tr-muted">Scores are computed in code from the rubric statuses above (scoring {r.scoring.version}). The AI never writes the number.</p>
    </section>
    <div className="ar-two">
      <section className="tr-card"><h2 className="tr-h3">Your reasoning</h2><p>{r.feedback.reasoning}</p>
        <h3 className="tr-eyebrow ar-good">What you got right</h3>{r.feedback.gotRight.length ? <ul className="ar-list">{r.feedback.gotRight.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="tr-muted">Nothing in the justification matched the rubric.</p>}
        <h3 className="tr-eyebrow ar-bad">What you missed</h3>{r.feedback.missed.length ? <ul className="ar-list">{r.feedback.missed.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="tr-muted">Nothing. Every rubric point was covered.</p>}
        {r.feedback.incorrectClaims.length > 0 && <><h3 className="tr-eyebrow ar-bad">Incorrect claims</h3><ul className="ar-list">{r.feedback.incorrectClaims.map((c, i) => <li key={i}><q>{c.claim}</q> {c.why}</li>)}</ul></>}
      </section>
      <section className="tr-card"><h2 className="tr-h3">Why the best answer works</h2>
        <p><b className="ar-option-id">{r.correctOption}</b> {opt(r.correctOption).text}</p><p>{r.feedback.whyBest}</p>
        <h3 className="tr-eyebrow">Why the alternatives are weaker</h3>
        <ul className="ar-alts">{r.feedback.whyAlternatives.map((a) => <li key={a.option}><b className="ar-option-id">{a.option}</b><span><span className="tr-small tr-muted">{opt(a.option).text}</span><span>{a.why}</span><span className="tr-small tr-muted">Verdict: {opt(a.option).verdict}</span></span></li>)}</ul>
      </section>
    </div>
    <section className="tr-card"><h2 className="tr-h3">Architecture analysis</h2><p className="ar-prose">{r.feedback.architectureAnalysis}</p></section>
    <section className="tr-card"><h2 className="tr-h3">Expert explanation</h2><p className="ar-prose">{r.feedback.expertExplanation}</p><div className="tr-chips">{r.concepts.map((c) => <span key={c} className="tr-tag tr-tag-plain">{c}</span>)}</div></section>
    <section className="tr-card"><h2 className="tr-h3">How to improve</h2><ul className="ar-list">{r.feedback.improve.map((x) => <li key={x}>{x}</li>)}</ul></section>
    {startErr ? <Err e={startErr} /> : null}
    <div className="ar-actions">
      <button type="button" className="tr-btn tr-btn-primary" disabled={starting} onClick={async () => { setStarting(true); setStartErr(null); try { const a = await reasoning.create(item.domain); go(`${BASE}attempts/${a.id}`); } catch (e) { setStartErr(e); setStarting(false); } }}>{starting ? 'Starting…' : 'New assessment in this domain'}</button>
      <a className="tr-btn tr-btn-secondary" href={`${BASE}domains/${domainSlug}`} onClick={(e) => { e.preventDefault(); go(`${BASE}domains/${domainSlug}`); }}>Back to domain</a>
      <a className="tr-btn tr-btn-ghost" href={`${BASE}history`} onClick={(e) => { e.preventDefault(); go(`${BASE}history`); }}>History</a>
    </div>
  </div>;
}

/* ---------------- History and analytics ---------------- */

export function HistoryPage({ go }: { go: (to: string) => void }) {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [items, setItems] = useState<AttemptSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = useCallback(() => { setErr(null); Promise.all([reasoning.dashboard(), reasoning.list()]).then(([d, l]) => { setDash(d); setItems(l.items); setCursor(l.nextCursor); }, (e) => { if (!(e instanceof ApiError && e.status === 401)) setErr(e); }); }, []);
  useEffect(load, [load]);
  const more = async () => { if (!cursor) return; const l = await reasoning.list(cursor); setItems((x) => [...x, ...l.items]); setCursor(l.nextCursor); };
  return <>
    <section className="tr-page-head"><div className="tr-wrap"><Crumbs items={[{ label: 'All domains', to: BASE, go }, { label: 'History' }]} /><div className="tr-page-head-in"><div><span className="tr-eyebrow">Attack Reasoning Lab</span><h1 className="tr-h1">Your assessments</h1><p className="tr-lead">Every attempt, its score and how your reasoning is trending across dimensions.</p></div></div></div></section>
    <div className="tr-wrap tr-section">
      {err ? <Err e={err} onRetry={load} /> : null}
      {!dash && !err && <Loading text="Loading history…" />}
      {dash && <>
        <div className="ar-stats">
          <div className="tr-card"><span className="tr-eyebrow">Evaluated</span><b className="tr-h2">{dash.evaluated}</b><span className="tr-small tr-muted">of {dash.attempts} attempts</span></div>
          <div className="tr-card"><span className="tr-eyebrow">Average score</span><b className="tr-h2">{dash.averageScore ?? '—'}</b><span className="tr-small tr-muted">best {dash.bestScore ?? '—'}</span></div>
          <div className="tr-card"><span className="tr-eyebrow">Correct decisions</span><b className="tr-h2">{dash.correctRate === null ? '—' : `${Math.round(dash.correctRate * 100)}%`}</b><span className="tr-small tr-muted">{dash.inProgress} in progress</span></div>
          <div className="tr-card"><span className="tr-eyebrow">Trend</span>{dash.scoreHistory.length > 1 ? <Spark values={dash.scoreHistory.map((s) => s.score)} /> : <span className="tr-small tr-muted">Complete two assessments to see a trend.</span>}</div>
        </div>
        <div className="ar-two">
          <section className="tr-card"><h2 className="tr-h3">By dimension</h2><div className="ar-dims">{dash.dimensionAverages.map((d) => <div key={d.key} className="ar-dim"><div className="ar-dim-head"><span>{d.label}</span><span className="tr-mono">{d.average === null ? '—' : `${d.average}%`}</span></div><div className="tr-progress" aria-hidden="true"><span style={{ width: `${d.average ?? 0}%` }} /></div></div>)}</div><p className="tr-small tr-muted">Average share of each dimension's points earned across evaluated attempts.</p></section>
          <section className="tr-card"><h2 className="tr-h3">By domain</h2>{dash.byDomain.length ? <table className="ar-table"><thead><tr><th>Domain</th><th>Evaluated</th><th>Average</th><th>Best</th></tr></thead><tbody>{dash.byDomain.map((d) => <tr key={d.domain}><td><a className="ar-link" href={`${BASE}domains/${DOMAIN_SLUG(d.domain)}`} onClick={(e) => { e.preventDefault(); go(`${BASE}domains/${DOMAIN_SLUG(d.domain)}`); }}>{d.title}</a></td><td className="tr-mono">{d.stats.evaluated}</td><td className="tr-mono">{d.stats.averageScore ?? '—'}</td><td className="tr-mono">{d.stats.bestScore ?? '—'}</td></tr>)}</tbody></table> : <p className="tr-muted">No attempts yet.</p>}</section>
        </div>
        <section className="tr-card"><h2 className="tr-h3">All attempts</h2>
          {items.length === 0 ? <p className="tr-muted">No attempts yet. <a className="ar-link" href={BASE} onClick={(e) => { e.preventDefault(); go(BASE); }}>Choose a domain</a> to start.</p> : <table className="ar-table"><thead><tr><th>Scenario</th><th>Domain</th><th>State</th><th>Score</th><th>When</th></tr></thead><tbody>{items.map((a) => <tr key={a.id}><td><a className="ar-link" href={`${BASE}attempts/${a.id}`} onClick={(e) => { e.preventDefault(); go(`${BASE}attempts/${a.id}`); }}>{a.title ?? 'Scenario'}</a></td><td className="tr-small">{cap(a.domain.replace(/_/g, ' '))}</td><td><StateTag state={a.state} /></td><td className="tr-mono">{a.totalScore ?? '—'}{a.correct !== null && <span className="tr-small tr-muted"> {a.correct ? '· correct' : '· incorrect'}</span>}</td><td className="tr-small">{fmtDate(a.createdAt)}</td></tr>)}</tbody></table>}
          {cursor && <button type="button" className="tr-btn tr-btn-secondary tr-btn-sm" onClick={more}>Load more</button>}
        </section>
      </>}
    </div>
  </>;
}

function Spark({ values }: { values: number[] }) {
  const w = 160; const h = 44;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / 100) * h}`).join(' ');
  return <svg className="ar-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-label={`Scores: ${values.join(', ')}`}><polyline fill="none" stroke="currentColor" strokeWidth="2" points={pts} /></svg>;
}
