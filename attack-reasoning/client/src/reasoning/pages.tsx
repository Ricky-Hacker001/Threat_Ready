import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ApiError, BASE } from '../api';
import { ArchitectureDiagram } from './Diagram';
import { beginSession, currentSession, DIFFICULTIES, DIMENSION_SHORT, DOMAIN_SLUG, endSession, FAILURE_MESSAGE, isNotFound, messageFor, reasoning, rememberDifficulty, rememberedDifficulty, startQuestion, uuid, type AttemptSummary, type AttemptView, type Dashboard, type Difficulty, type DomainView, type OptionId, type PoolStatus, type Result } from './api';

const MIN_JUSTIFICATION = 40;
const MAX_JUSTIFICATION = 4000;
const TRANSIENT = new Set(['generating', 'evaluating']);
const fmtDate = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "4 min 05 s" from seconds (answer time: wall-clock, shown for information, never scored). */
const fmtDuration = (sec: number) => (sec < 60 ? `${sec} s` : sec < 3600 ? `${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, '0')} s` : `${Math.floor(sec / 3600)} h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')} min`);
/**
 * A skipped question that counts as answered with 0, as the server decides it: shown, then skipped or
 * left to expire. A skip before it was shown does not count, nor does one from before the rule existed.
 */
const countsAsSkipped = (a: AttemptSummary) => a.countsAsZero === true;
const SKIP_RULE = 'Skipped questions are recorded and count as 0 in your averages.';

/** An unanswered question's draft (option and justification), kept in this tab per attempt so a reload or a slip does not lose it. */
interface Draft { selected: OptionId | null; text: string }
const draftKey = (id: string) => `ar-draft:${id}`;
const loadDraft = (id: string): Draft => { try { const v = JSON.parse(sessionStorage.getItem(draftKey(id)) || 'null'); return v && typeof v.text === 'string' ? { selected: v.selected ?? null, text: v.text } : { selected: null, text: '' }; } catch { return { selected: null, text: '' }; } };
const saveDraft = (id: string, d: Draft) => { try { if (!d.selected && !d.text) sessionStorage.removeItem(draftKey(id)); else sessionStorage.setItem(draftKey(id), JSON.stringify(d)); } catch { /* storage unavailable */ } };
const clearDraft = (id: string) => { try { sessionStorage.removeItem(draftKey(id)); } catch { /* storage unavailable */ } };

/** A technique as "T1078 · Valid Accounts": the name is visible text, not a tooltip only. */
const TechniqueChips = ({ list }: { list: { id: string; name: string }[] }) => <ul className="tr-chips ar-chip-list" aria-label="Techniques">{list.map((t) => <li key={t.id} className="tr-chip">{t.id} · {t.name}</li>)}</ul>;

const STATE_TAG: Record<string, { label: string; cls: string }> = {
  generating: { label: 'Generating', cls: 'tr-tag-info' },
  ready: { label: 'Ready', cls: 'tr-tag-accent' },
  evaluating: { label: 'Evaluating', cls: 'tr-tag-info' },
  evaluated: { label: 'Evaluated', cls: 'tr-tag-live' },
  generation_failed: { label: 'Generation failed', cls: 'tr-tag-soon' },
  evaluation_failed: { label: 'Evaluation failed', cls: 'tr-tag-soon' },
  abandoned: { label: 'Skipped', cls: 'tr-tag-plain' },
};
const StateTag = ({ state }: { state: string }) => { const t = STATE_TAG[state] ?? { label: state, cls: 'tr-tag-plain' }; return <span className={`tr-tag ${t.cls}`}>{t.label}</span>; };

/** Domain display names ("AI & LLM Security"), fetched once per page load; the key is the fallback while loading. */
let domainTitlesFetch: Promise<Map<string, string>> | null = null;
function useDomainTitles(): (key: string) => string {
  const [titles, setTitles] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    let on = true;
    domainTitlesFetch ??= reasoning.domains().then((ds) => new Map(ds.map((d) => [d.key, d.title])), () => { domainTitlesFetch = null; return new Map(); });
    domainTitlesFetch.then((m) => { if (on) setTitles(m); });
    return () => { on = false; };
  }, []);
  return (key: string) => titles?.get(key) ?? cap(key.replace(/_/g, ' '));
}

function Crumbs({ items }: { items: { label: string; to?: string; go?: (to: string) => void }[] }) {
  return <nav className="ar-crumbs" aria-label="Breadcrumb">{items.map((c, i) => <span key={i} className="ar-crumb">{i > 0 && <span aria-hidden="true">/</span>}{c.to && c.go ? <a href={c.to} onClick={(e) => { e.preventDefault(); c.go!(c.to!); }}>{c.label}</a> : <span>{c.label}</span>}</span>)}</nav>;
}

function Err({ e, onRetry }: { e: unknown; onRetry?: () => void }) {
  return <div className="tr-note tr-note-bad" role="alert">{messageFor(e)} {onRetry && <button className="tr-btn tr-btn-secondary tr-btn-sm" onClick={onRetry}>Retry</button>}</div>;
}
const Loading = ({ text }: { text: string }) => <div className="tr-note"><span className="tr-spinner" aria-hidden="true" />{text}</div>;

const APP_TITLE = 'Attack Reasoning Lab · ThreatReady';
/** The tab title for this screen ("Cloud Security · Attack Reasoning Lab · ThreatReady", WCAG 2.4.2); null until the screen knows its name. */
function useTabTitle(title: string | null | undefined) {
  useEffect(() => { if (!title) return undefined; document.title = `${title} · ${APP_TITLE}`; return () => { document.title = APP_TITLE; }; }, [title]);
}

/**
 * An address that names nothing this learner can open: a heading that says so and the ways back, and
 * "not found" in the tab title. No Retry, since asking again changes nothing (final review UI-5).
 */
function NotFound({ title, tabTitle, children, links, go }: { title: string; tabTitle: string; children: ReactNode; links: { label: string; to: string }[]; go: (to: string) => void }) {
  useTabTitle(tabTitle);
  return <>
    <section className="tr-page-head"><div className="tr-wrap"><Crumbs items={[{ label: 'All domains', to: BASE, go }, { label: 'Not found' }]} />
      <div className="tr-page-head-in"><div>
        <span className="tr-eyebrow"><span className="tr-dot tr-dot-reasoning" aria-hidden="true" style={{ marginRight: 8 }} />Attack Reasoning Lab</span>
        <h1 className="tr-h1">{title}</h1>
        <p className="tr-lead">{children}</p>
      </div></div>
    </div></section>
    <div className="tr-wrap tr-section"><div className="ar-actions">{links.map((l, i) => <a key={l.to} className={`tr-btn ${i === 0 ? 'tr-btn-primary' : 'tr-btn-secondary'}`} href={l.to} onClick={(e) => { e.preventDefault(); go(l.to); }}>{l.label}</a>)}</div></div>
  </>;
}
/** /ar/attempts/<id> for an attempt that does not exist, is someone else's, or an id that is not a UUID. */
export const AttemptNotFound = ({ go }: { go: (to: string) => void }) => <NotFound title="This assessment doesn’t exist or isn’t yours" tabTitle="Assessment not found" go={go} links={[{ label: 'Your assessments', to: `${BASE}history` }, { label: 'All domains', to: BASE }]}>The link may be mistyped or out of date. Every assessment you have started is listed in your history.</NotFound>;
/** /ar/domains/<slug> for a slug that names no domain. */
export const DomainNotFound = ({ go }: { go: (to: string) => void }) => <NotFound title="That domain does not exist" tabTitle="Domain not found" go={go} links={[{ label: 'All domains', to: BASE }, { label: 'Your assessments', to: `${BASE}history` }]}>The link may be mistyped or out of date. Every Attack Reasoning domain is listed on the domains page.</NotFound>;

/**
 * An attempts table that reads as one block per attempt on phones (app.css .ar-table-stack). The rows
 * stop being table rows there, so the roles are explicit and each cell carries its column name.
 */
function AttemptsTable({ label, head, rows }: { label: string; head: string[]; rows: { key: string; cells: { node: ReactNode; cls?: string }[] }[] }) {
  return <table className="ar-table ar-table-stack" role="table" aria-label={label}>
    <thead role="rowgroup"><tr role="row">{head.map((h) => <th key={h} role="columnheader">{h}</th>)}</tr></thead>
    <tbody role="rowgroup">{rows.map((r) => <tr key={r.key} role="row">{r.cells.map((c, i) => <td key={i} role="cell" className={c.cls} data-label={head[i]}>{c.node}</td>)}</tr>)}</tbody>
  </table>;
}
const scoreCell = (a: AttemptSummary) => <>{a.totalScore ?? (countsAsSkipped(a) ? '0' : '—')}{a.correct !== null ? <span className="tr-small tr-muted"> {a.correct ? '· correct' : '· incorrect'}</span> : countsAsSkipped(a) ? <span className="tr-small tr-muted"> · skipped</span> : null}</>;

/**
 * Ready pool questions for a domain and level. It asks again only while the server reports more on
 * their way (`refilling`), backing off from 5 s to a minute for at most ten minutes; otherwise the
 * next start generates a question on demand. Prefetching is optional: an error just stops it.
 */
function usePoolStatus(domain: string | null, difficulty: Difficulty, refresh: unknown): PoolStatus | 'error' | null {
  const [status, setStatus] = useState<PoolStatus | 'error' | null>(null);
  useEffect(() => {
    if (!domain) return undefined;
    let on = true;
    let t: number | undefined;
    let delay = 5000;
    const until = Date.now() + 10 * 60_000;
    setStatus(null);
    const poll = async () => {
      try {
        const s = await reasoning.pool(domain, difficulty);
        if (!on) return;
        const waiting = s.available === 0 && s.refilling;
        const more = waiting && Date.now() + delay < until;
        // Past the polling window nothing has arrived: say the next start generates on demand instead.
        setStatus(waiting && !more ? { ...s, refilling: false } : s);
        if (more) { t = window.setTimeout(poll, delay); delay = Math.min(60_000, delay * 2); }
      } catch { if (on) setStatus('error'); }
    };
    void poll();
    return () => { on = false; if (t) window.clearTimeout(t); };
  }, [domain, difficulty, refresh]);
  return status;
}

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
      {dash && dash.attempts > 0 && <div className="tr-strip ar-strip-row"><div><b>Your progress:</b> {dash.evaluated} evaluated{dash.skipped > 0 && <>, {dash.skipped} skipped</>}, {dash.inProgress} in progress{dash.bestScore !== null && <>, best {dash.bestScore}/100</>}.</div><a className="ar-link" href={`${BASE}history`} onClick={(e) => { e.preventDefault(); go(`${BASE}history`); }}>History and analytics →</a></div>}
      {domains && <>
        <h2 className="tr-section-title">Domains</h2>
        <ul className="tr-grid">{domains.map((d) => <li key={d.key} className={`tr-card ar-card ${d.available ? '' : 'is-soon'}`}>
          <div className="tr-card-top"><span className="tr-eyebrow" style={{ margin: 0 }}>{d.track}</span>{d.available ? <span className="tr-tag tr-tag-live">Live</span> : <span className="tr-tag tr-tag-soon">Coming soon</span>}</div>
          <h3 className="tr-h3">{d.available ? <a className="ar-card-link" href={`${BASE}domains/${DOMAIN_SLUG(d.key)}`} onClick={(e) => { e.preventDefault(); go(`${BASE}domains/${DOMAIN_SLUG(d.key)}`); }}>{d.title}</a> : d.title}</h3>
          <p>{d.description}</p>
          <div className="tr-card-foot"><span className="tr-mono">{d.stats.attempts ? `${d.stats.evaluated} evaluated${d.stats.skipped ? ` · ${d.stats.skipped} skipped` : ''} · avg ${d.stats.averageScore ?? '—'}` : d.available ? `${DIFFICULTIES[0]!.label} to ${DIFFICULTIES[DIFFICULTIES.length - 1]!.label} · AI-generated` : 'Roadmap'}</span>{d.available && <span className="ar-more" aria-hidden="true">Start →</span>}</div>
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
  useTabTitle(domain?.title);
  const [history, setHistory] = useState<AttemptSummary[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [difficulty, setDifficulty] = useState<Difficulty>(() => rememberedDifficulty(key));
  const load = useCallback(() => { setErr(null); Promise.all([reasoning.domains(), reasoning.list()]).then(([ds, l]) => { setDomain(ds.find((d) => d.key === key) ?? null); setHistory(l.items.filter((a) => a.domain === key)); }, (e) => { if (!(e instanceof ApiError && e.status === 401)) setErr(e); }); }, [key]);
  useEffect(load, [load]);
  // Ready questions for this level; the server restocks in the background when the learner is running low.
  const pool = usePoolStatus(domain?.available ? key : null, difficulty, null);
  const available = pool && pool !== 'error' ? pool.available : null;
  const warm = !pool ? 'checking' : pool === 'error' ? 'idle' : pool.available > 0 ? 'ready' : pool.refilling ? 'generating' : 'on_demand';
  const pick = (d: Difficulty) => { setDifficulty(d); rememberDifficulty(key, d); };
  // Radio group keyboard pattern: one tab stop; arrow keys move the selection and focus.
  const levelKeys = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = DIFFICULTIES.length; let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % n; else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + n) % n; else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = n - 1;
    if (j < 0) return;
    e.preventDefault(); pick(DIFFICULTIES[j]!.key);
    (e.currentTarget.parentElement?.children[j] as HTMLElement | undefined)?.focus();
  };
  const start = async () => { setStarting(true); setErr(null); try { const a = await startQuestion(key, difficulty); if (!a) { setStarting(false); return; } beginSession(key, difficulty); go(`${BASE}attempts/${a.id}`); } catch (e) { setErr(e); setStarting(false); } };
  // Only an unfinished question at the selected level is offered to continue; another level starts fresh.
  const open = history.find((a) => (TRANSIENT.has(a.state) || a.state === 'ready') && a.difficulty === difficulty);
  /** "Start a new one instead": an unanswered question is skipped first, after asking (it counts as 0 once shown); an answer being evaluated keeps evaluating. */
  const startInstead = async () => {
    if (!open) return start();
    const skips = open.state === 'ready' || open.state === 'generating';
    if (skips && !window.confirm(open.state === 'ready' ? `Start a new ${difficulty} question? Your unfinished one is recorded as skipped and counts as 0 in your averages, and its draft answer is discarded.` : `Start a new ${difficulty} question? Your unfinished one has not been shown yet, so skipping it does not count.`)) return;
    setStarting(true); setErr(null);
    try { if (skips) { await reasoning.abandon(open.id); clearDraft(open.id); } } catch (e) { setErr(e); setStarting(false); return; }
    await start();
  };
  if (domain === null) return <DomainNotFound go={go} />;
  return <>
    <section className="tr-page-head"><div className="tr-wrap">
      <Crumbs items={[{ label: 'All domains', to: BASE, go }, { label: domain?.title ?? cap(key.replace(/_/g, ' ')) }]} />
      {domain && <div className="tr-page-head-in">
        <div><span className="tr-eyebrow">{domain.track} · {cap(difficulty)}</span><h1 className="tr-h1">{domain.title}</h1><p className="tr-lead">{domain.description}</p></div>
        <div className="ar-start">
          <div className="ar-levels" role="radiogroup" aria-label="Difficulty" aria-describedby="ar-level-blurb">{DIFFICULTIES.map((d, i) => <button key={d.key} type="button" role="radio" aria-checked={difficulty === d.key} tabIndex={difficulty === d.key ? 0 : -1} className={`ar-level ${difficulty === d.key ? 'is-selected' : ''}`} onClick={() => pick(d.key)} onKeyDown={(e) => levelKeys(e, i)}>{d.label}</button>)}</div>
          <span className="tr-small tr-muted" id="ar-level-blurb">{DIFFICULTIES.find((d) => d.key === difficulty)!.blurb}</span>
          {open ? <>
            <button type="button" className="tr-btn tr-btn-primary" onClick={() => { if (!currentSession()) beginSession(key, difficulty); go(`${BASE}attempts/${open.id}`); }}>Continue assessment</button>
            <span className="tr-small tr-muted">You have an unfinished {difficulty} question. <a className="ar-link" href={BASE} aria-disabled={starting} onClick={(e) => { e.preventDefault(); if (!starting) void startInstead(); }}>{starting ? 'Starting…' : 'Start a new one instead'}</a>{open.state === 'ready' && ' (the unfinished one counts as 0)'}.</span>
          </> : <>
            <button type="button" className="tr-btn tr-btn-primary" disabled={starting} onClick={start}>{starting ? 'Starting…' : warm === 'ready' ? 'Start now' : 'Start assessment'}</button>
            <span className="tr-small tr-muted">{warm === 'ready' ? `${available} new ${difficulty} question${available === 1 ? '' : 's'} ready for you.` : warm === 'generating' ? `Preparing new ${difficulty} questions in the background…` : warm === 'on_demand' ? `Your next ${difficulty} question is generated when you start (about a minute).` : 'One generated scenario, one decision, your reasoning. About 10 minutes.'}</span>
          </>}
        </div>
      </div>}
    </div></section>
    <div className="tr-wrap tr-section">
      {err ? <Err e={err} onRetry={load} /> : null}
      {domain === undefined && !err && <Loading text="Loading domain…" />}
      {domain && <div className="ar-detail-grid">
        <div className="ar-main">
          <section className="tr-card"><h2 className="tr-h3">What this domain assesses</h2><ul className="ar-list">{domain.focus.map((f) => <li key={f}>{f}</li>)}</ul></section>
          <section className="tr-card"><h2 className="tr-h3">Your attempts</h2>
            {history.length === 0 ? <p className="tr-muted">No attempts yet. Your first scenario is generated when you start.</p> : <AttemptsTable label="Your attempts in this domain" head={['Scenario', 'State', 'Score', 'When']} rows={history.map((a) => ({ key: a.id, cells: [{ node: <a className="ar-link" href={`${BASE}attempts/${a.id}`} onClick={(e) => { e.preventDefault(); go(`${BASE}attempts/${a.id}`); }}>{a.title ?? 'Scenario'}</a>, cls: 'ar-cell-title' }, { node: <StateTag state={a.state} /> }, { node: scoreCell(a), cls: 'tr-mono' }, { node: fmtDate(a.createdAt), cls: 'tr-small' }] }))} />}
          </section>
        </div>
        <aside className="ar-side">
          <section className="tr-card"><h2 className="tr-h3">Scoring</h2>
            {domain.weights && <table className="ar-table"><tbody>{(Object.keys(domain.weights) as (keyof typeof domain.weights)[]).map((k) => <tr key={k}><td>{DIMENSION_SHORT[k]}</td><td className="tr-mono">{domain.weights![k]} pts</td></tr>)}</tbody></table>}
            <p className="tr-small">A correct guess with weak reasoning scores low; a wrong decision with sound architecture analysis still earns partial credit on reasoning dimensions.</p></section>
          <section className="tr-card"><h2 className="tr-h3">Techniques in play</h2><TechniqueChips list={domain.techniques} /></section>
          {domain.stats.attempts > 0 && <section className="tr-card"><h2 className="tr-h3">Your stats</h2><ul className="ar-list"><li>{domain.stats.evaluated} evaluated of {domain.stats.attempts}{domain.stats.skipped > 0 && <>, {domain.stats.skipped} skipped</>}</li><li>Average {domain.stats.averageScore ?? '—'}, best {domain.stats.bestScore ?? '—'}</li></ul><p className="tr-small tr-muted">{SKIP_RULE}</p></section>}
        </aside>
      </div>}
    </div>
  </>;
}

/* ---------------- Attempt page ---------------- */

/** The attempt, polled every 2.5 s while it is generating or evaluating: one poller, which also resumes after a submit or retry. */
function useAttempt(id: string) {
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const refresh = useCallback(async () => { try { const a = await reasoning.get(id); setAttempt(a); setErr(null); return a; } catch (e) { if (!(e instanceof ApiError && e.status === 401)) setErr(e); return null; } }, [id]);
  useEffect(() => { void refresh(); }, [refresh]);
  // Each new snapshot schedules the next poll while the state is transient; a submit's response restarts it.
  useEffect(() => {
    if (!attempt || !TRANSIENT.has(attempt.state)) return undefined;
    const t = window.setTimeout(() => { void refresh(); }, 2500);
    return () => window.clearTimeout(t);
  }, [attempt, refresh]);
  return { attempt, err, refresh, setAttempt };
}

export function AttemptPage({ id, go }: { id: string; go: (to: string) => void }) {
  const { attempt, err, refresh, setAttempt } = useAttempt(id);
  useTabTitle(attempt ? (attempt.item?.title ?? 'Assessment') : null);
  const [selected, setSelected] = useState<OptionId | null>(() => loadDraft(id).selected);
  const [text, setText] = useState(() => loadDraft(id).text);
  const [submitting, setSubmitting] = useState(false);
  const [subErr, setSubErr] = useState<unknown>(null);
  const [result, setResult] = useState<Result | null>(null);
  const submissionId = useRef(uuid());
  const [slow, setSlow] = useState(false);
  const state = attempt?.state;
  useEffect(() => { setSlow(false); if (state && TRANSIENT.has(state)) { const t = window.setTimeout(() => setSlow(true), 75_000); return () => window.clearTimeout(t); } return undefined; }, [state]);
  useEffect(() => { if (state === 'evaluated' && !result) reasoning.result(id).then(setResult, setSubErr); }, [state, id, result]);
  // While the learner reads and answers, the pool is restocked for the next question at this difficulty.
  const watching = attempt && (state === 'ready' || state === 'evaluating' || state === 'evaluated') ? attempt.domain : null;
  const nextPool = usePoolStatus(watching, (attempt?.difficulty ?? 'intermediate') as Difficulty, state);
  const nextReady = Boolean(nextPool && nextPool !== 'error' && nextPool.available > 0);
  const nextOnDemand = Boolean(nextPool && nextPool !== 'error' && nextPool.available === 0 && !nextPool.refilling);
  const [moving, setMoving] = useState(false);
  const [ending, setEnding] = useState(false);
  /** Ends the session: an unanswered question is skipped, an answer being evaluated keeps evaluating. */
  const endAssessment = async () => {
    if (!attempt) return;
    const unanswered = attempt.state === 'ready' || attempt.state === 'generating' || attempt.state === 'generation_failed';
    const shown = attempt.state === 'ready';
    if (unanswered && !window.confirm(shown ? `End the assessment? This unanswered question is recorded as skipped${attempt.skipCounts ? ' and counts as 0 in your averages' : ''}.${text.trim() || selected ? ' Your draft answer will be discarded.' : ''}` : 'End the assessment? This question has not been shown yet, so skipping it does not count.')) return;
    setEnding(true); setSubErr(null);
    try {
      if (unanswered) { await reasoning.abandon(attempt.id); clearDraft(attempt.id); }
      const s = currentSession();
      const since = s && s.domain === attempt.domain ? s.startedAt : attempt.createdAt;
      endSession();
      go(`${BASE}summary?domain=${encodeURIComponent(attempt.domain)}&since=${encodeURIComponent(since)}`);
    } catch (e) { setSubErr(e); setEnding(false); }
  };
  const nextScenario = async (skipCurrent: boolean) => {
    if (!attempt) return;
    // A skip is recorded and counts as 0, and it throws away an unsent draft: always ask first (audit BIZ-09).
    if (skipCurrent && !window.confirm(`Skip this question? It is recorded as skipped${attempt.skipCounts ? ' and counts as 0 in your averages' : ''}.${text.trim() || selected ? ' Your draft answer will be discarded.' : ''}`)) return;
    setMoving(true); setSubErr(null);
    try {
      if (skipCurrent) { await reasoning.abandon(attempt.id); clearDraft(attempt.id); }
      const a = await startQuestion(attempt.domain, attempt.difficulty as Difficulty);
      if (!a) { setMoving(false); if (skipCurrent) void refresh(); return; }
      go(`${BASE}attempts/${a.id}`);
    } catch (e) { setSubErr(e); setMoving(false); }
  };
  // The draft follows every change while the question is open, and leaving the page with an unsent justification asks first.
  useEffect(() => { if (state === 'ready') saveDraft(id, { selected, text }); }, [id, state, selected, text]);
  useEffect(() => {
    if (state !== 'ready' || !text.trim()) return undefined;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state, text]);
  // Async states announced politely, and focus moves to the result when it arrives on this page.
  const [announce, setAnnounce] = useState('');
  const prevState = useRef<string | undefined>(undefined);
  const watched = useRef(false);
  useEffect(() => {
    const prev = prevState.current; prevState.current = state;
    if (!state || prev === state) return;
    if (state === 'generating') { watched.current = true; setAnnounce('Generating your scenario. This usually takes under a minute.'); }
    else if (state === 'evaluating') { watched.current = true; setAnnounce('Your answer was submitted. Evaluating in three stages; this usually takes one to two minutes.'); }
    else if (state === 'ready' && prev === 'generating') setAnnounce('Your scenario is ready.');
    else if (state === 'generation_failed') setAnnounce('Scenario generation failed. You can retry.');
    else if (state === 'evaluation_failed') setAnnounce('Evaluation failed. Your answer is saved; you can retry.');
  }, [state]);
  const domainSlug = attempt ? DOMAIN_SLUG(attempt.domain) : '';
  const titleOf = useDomainTitles();
  const crumbs = [{ label: 'All domains', to: BASE, go }, { label: attempt ? titleOf(attempt.domain) : 'Domain', to: attempt ? `${BASE}domains/${domainSlug}` : undefined, go }, { label: attempt?.item?.title ?? 'Assessment' }];

  const submit = async () => {
    if (!attempt || !selected) return;
    setSubmitting(true); setSubErr(null);
    try { const a = await reasoning.submit(attempt.id, selected, text.trim(), submissionId.current); clearDraft(attempt.id); setAttempt(a); }
    catch (e) { setSubErr(e); }
    finally { setSubmitting(false); }
  };
  const retry = async () => { if (!attempt) return; setSubErr(null); try { const a = await reasoning.retry(attempt.id); setAttempt(a); } catch (e) { setSubErr(e); } };
  const chars = text.trim().length;
  const canSubmit = Boolean(selected) && chars >= MIN_JUSTIFICATION && chars <= MAX_JUSTIFICATION && !submitting;
  // The counter is read on demand (it describes the field); only crossing the minimum is announced.
  const [lengthNote, setLengthNote] = useState('');
  const longEnough = chars >= MIN_JUSTIFICATION;
  const wasLongEnough = useRef(longEnough);
  useEffect(() => { if (longEnough !== wasLongEnough.current) { wasLongEnough.current = longEnough; setLengthNote(longEnough ? 'Minimum length reached.' : `At least ${MIN_JUSTIFICATION} characters are needed.`); } }, [longEnough]);
  const endButton = <button type="button" className="tr-btn tr-btn-secondary tr-btn-sm ar-end" disabled={ending} onClick={endAssessment}>{ending ? 'Ending…' : 'End assessment'}</button>;

  // An unknown or foreign attempt (or a malformed id) is a not-found page, not an error with a Retry.
  if (isNotFound(err)) return <AttemptNotFound go={go} />;
  return <>
    <section className="tr-page-head"><div className="tr-wrap"><Crumbs items={crumbs} />
      {attempt && <div className="tr-page-head-in"><div>
        <span className="tr-eyebrow">{titleOf(attempt.domain)}{attempt.item && <> · {cap(attempt.item.difficulty)}</>} · <StateTag state={attempt.state} /></span>
        <h1 className="tr-h1">{attempt.item?.title ?? (attempt.state === 'generating' ? 'Building your scenario' : 'Assessment')}</h1>
        {attempt.item && <p className="tr-lead">{attempt.item.objective}</p>}
      </div></div>}
    </div></section>
    <div className="tr-wrap tr-section">
      {err ? <Err e={err} onRetry={refresh} /> : null}
      {!attempt && !err && <Loading text="Loading assessment…" />}
      <p className="tr-sr" role="status" aria-live="polite">{announce}</p>
      {attempt?.state === 'generating' && <div className="tr-card ar-wait" role="status">
        <span className="tr-spinner" aria-hidden="true" />
        <div><h2 className="tr-h3">Generating a unique scenario</h2><p>The AI is building an architecture, an attack narrative and a diagram for you. Each item is validated in code and checked against your previous questions before you see it.</p><p className="tr-small tr-muted">{slow ? 'This is taking longer than usual. The attempt is saved; you can leave this page and come back.' : 'Usually under a minute.'}</p><button type="button" className="tr-btn tr-btn-secondary ar-end" disabled={ending} onClick={endAssessment}>{ending ? 'Ending…' : 'End assessment'}</button></div>
      </div>}
      {attempt && (attempt.state === 'generation_failed' || attempt.state === 'evaluation_failed') && <div className="tr-note tr-note-bad" role="alert">
        <span><b>{attempt.state === 'generation_failed' ? 'Scenario generation failed.' : 'Evaluation failed.'}</b> {FAILURE_MESSAGE(attempt.failure?.code ?? '')} {attempt.state === 'evaluation_failed' && 'Your answer is saved.'}</span> <span className="ar-note-actions"><button className="tr-btn tr-btn-secondary tr-btn-sm" onClick={retry}>Retry</button>{endButton}</span>
      </div>}
      {subErr ? <Err e={subErr} /> : null}
      {attempt?.state === 'abandoned' && <div className="tr-note" role="status">
        <span>{!attempt.item ? 'This question was skipped before it was shown, so it does not count.' : attempt.skipCounts ? `This question was skipped: you skipped it, it was left unanswered until it expired, or you confirmed skipping it to open a new one. It counts as 0 in your averages.` : 'This question was skipped before skipped questions counted, so it does not count in your averages.'}</span>
        <span className="ar-note-actions"><button type="button" className="tr-btn tr-btn-primary tr-btn-sm" disabled={moving} onClick={() => nextScenario(false)}>{moving ? 'Opening…' : 'Next question'}</button><a className="tr-btn tr-btn-ghost tr-btn-sm" href={`${BASE}domains/${domainSlug}`} onClick={(e) => { e.preventDefault(); go(`${BASE}domains/${domainSlug}`); }}>Back to domain</a></span>
      </div>}
      {attempt?.item && (attempt.state === 'ready' || attempt.state === 'evaluating' || attempt.state === 'evaluation_failed' || attempt.state === 'evaluated') && <div className="ar-assess">
        <section className="tr-card"><h2 className="tr-h3">The environment</h2><p className="ar-prose">{attempt.item.scenario}</p></section>
        <section className="tr-card"><h2 className="tr-h3">What happened</h2><p className="ar-prose">{attempt.item.attackNarrative}</p>
          <TechniqueChips list={attempt.item.techniques} /></section>
        {/* Wide screens: diagram and question side by side (app.css .ar-work). */}
        <div className="ar-work">
        <section className="tr-card ar-work-diagram"><h2 className="tr-h3">Architecture and attack path</h2><ArchitectureDiagram diagram={attempt.item.diagram} /></section>
        {attempt.state === 'ready' ? (
          <section className="tr-card ar-question">
            <span className="tr-eyebrow">Your decision</span>
            <h2 className="tr-h2" id="ar-question">{attempt.item.question}</h2>
            <div className="ar-options" role="radiogroup" aria-labelledby="ar-question">{attempt.item.options.map((o) => <label key={o.id} className={`ar-option ${selected === o.id ? 'is-selected' : ''}`}><input type="radio" name="option" value={o.id} checked={selected === o.id} onChange={() => setSelected(o.id)} /><b className="ar-option-id" aria-hidden="true">{o.id}</b><span><span className="tr-sr">Option {o.id}: </span>{o.text}</span></label>)}</div>
            <div className="ar-just">
              <label className="tr-eyebrow ar-just-label" htmlFor="ar-justification">Why this option?</label>
              <span className="tr-small tr-muted" id="ar-just-hint">State the evidence from the scenario and the diagram, the attack path you are breaking or tracing, the trade-offs, and why the alternatives are weaker. The evaluation grades this text; a correct guess without reasoning scores low. Your draft is kept in this tab until you submit.</span>
              <textarea id="ar-justification" aria-describedby="ar-just-hint ar-just-count" value={text} onChange={(e) => setText(e.target.value.slice(0, MAX_JUSTIFICATION))} rows={9} placeholder="The attacker is operating as … because the audit log shows … Revoking … breaks the path at … while … The alternatives …" />
              <span className="ar-counter tr-small tr-muted" id="ar-just-count">{chars < MIN_JUSTIFICATION ? `${MIN_JUSTIFICATION - chars} more characters needed` : `${chars.toLocaleString()} / ${MAX_JUSTIFICATION.toLocaleString()} characters`}</span>
              <span className="tr-sr" aria-live="polite">{lengthNote}</span>
            </div>
            <div className="ar-submit"><button type="button" className="tr-btn tr-btn-primary" disabled={!canSubmit} onClick={submit}>{submitting ? 'Submitting…' : 'Submit for evaluation'}</button><button type="button" className="tr-btn tr-btn-ghost" disabled={moving} onClick={() => nextScenario(true)} title={`Skip this scenario${attempt.skipCounts ? ' (it counts as 0)' : ''} and open the next architecture and question`}>{moving ? 'Opening…' : nextReady ? 'Skip to next scenario (ready)' : 'Skip to next scenario'}</button><button type="button" className="tr-btn tr-btn-secondary ar-end" disabled={ending} onClick={endAssessment}>{ending ? 'Ending…' : 'End assessment'}</button><span className="tr-small tr-muted">You see the correct answer and the feedback after your reasoning is evaluated. {attempt.skipCounts ? SKIP_RULE : 'Skipping this question does not count against your averages.'}{attempt.expiresAt && <> If it is still unanswered at {fmtDate(attempt.expiresAt)}, it is skipped automatically{attempt.skipCounts ? ' and counts as 0' : ''}, and the draft is discarded.</>}</span></div>
          </section>
        ) : (
          <section className="tr-card ar-question">
            <span className="tr-eyebrow">Your decision</span>
            <h2 className="tr-h2">{attempt.item.question}</h2>
            {attempt.answer && <div className="ar-answer"><p><b>Option {attempt.answer.selectedOption}.</b> {attempt.item.options.find((o) => o.id === attempt.answer!.selectedOption)?.text}</p><blockquote className="ar-quote">{attempt.answer.justification}</blockquote><span className="tr-small tr-muted">Submitted {fmtDate(attempt.answer.submittedAt)}{attempt.answer.answerSeconds !== null && <> · answered in {fmtDuration(attempt.answer.answerSeconds)}</>}</span></div>}
            {attempt.state === 'evaluating' && <div className="ar-wait ar-wait-inline" role="status"><span className="tr-spinner" aria-hidden="true" /><div><b>Evaluating in three stages</b><ol className="ar-stages"><li>Evaluator: grades your justification against the rubric with verbatim evidence</li><li>Challenger: looks for errors, invented references and over-credit</li><li>Reconciler: settles the disagreements and writes your feedback</li></ol><span className="tr-small tr-muted">{slow ? 'Taking longer than usual. Your answer is saved; you can come back later.' : 'Usually one to two minutes.'}</span><div className="ar-submit"><button type="button" className="tr-btn tr-btn-secondary ar-end" disabled={ending} onClick={endAssessment}>{ending ? 'Ending…' : 'End assessment'}</button><span className="tr-small tr-muted">Ending now keeps this answer: it finishes evaluating and appears in your summary.</span></div></div></div>}
          </section>
        )}
        </div>
        {attempt.state === 'evaluated' && (result ? <ResultView r={result} item={attempt.item} go={go} domainSlug={domainSlug} next={() => nextScenario(false)} nextReady={nextReady} nextOnDemand={nextOnDemand} moving={moving} end={endAssessment} ending={ending} focusOnMount={watched.current} /> : !subErr && <Loading text="Loading your result…" />)}
      </div>}
    </div>
  </>;
}

/* ---------------- Result ---------------- */

const CONF: Record<string, string> = { high: 'tr-tag-live', medium: 'tr-tag-info', low: 'tr-tag-soon' };

/** What the confidence level means, in the learner's terms. */
const CONF_TEXT: Record<string, string> = {
  high: 'the three grading stages agreed, so the score is reliable.',
  medium: 'the grading stages mostly agreed; small differences were settled by the reconciler.',
  low: 'the grading stages disagreed or one could not run, so treat the score as approximate.',
};

function ResultView({ r, item, go, domainSlug, next, nextReady, nextOnDemand, moving, end, ending, focusOnMount }: { r: Result; item: NonNullable<AttemptView['item']>; go: (to: string) => void; domainSlug: string; next: () => void; nextReady: boolean; nextOnDemand: boolean; moving: boolean; end: () => void; ending: boolean; focusOnMount?: boolean }) {
  const opt = (id: OptionId) => r.options.find((o) => o.id === id)!;
  const heading = useRef<HTMLHeadingElement>(null);
  // The result replaced the "Evaluating" panel on this page: move focus to it so it is read and in view.
  useEffect(() => { if (focusOnMount) heading.current?.focus(); }, [focusOnMount]);
  return <div className="ar-result">
    <section className="tr-card ar-score-card" aria-labelledby="ar-result-title">
      <div className="ar-score"><span className="ar-score-num">{r.totalScore}</span><span className="ar-score-den">/ 100</span></div>
      <div className="ar-score-side">
        <h2 className="tr-h2" id="ar-result-title" ref={heading} tabIndex={-1}><span className="tr-sr">Your result: {r.totalScore} out of 100. </span>{r.correct ? 'Correct decision' : 'Not the best decision'}</h2>
        <p>{r.feedback.decision}</p>
        <div className="tr-chips"><span className={`tr-tag ${CONF[r.confidence]}`}>Confidence: {r.confidence}</span>{r.reviewFlag && <span className="tr-tag tr-tag-soon">Uncertain grading</span>}{r.degraded && <span className="tr-tag tr-tag-soon">Simplified scoring</span>}</div>
        <ul className="ar-flag-notes">
          <li><b>Confidence {r.confidence}:</b> {CONF_TEXT[r.confidence] ?? ''}</li>
          {r.reviewFlag && <li><b>Uncertain grading:</b> the graders marked this result as uncertain (for example, they disagreed or the text looked off-topic). The score shown is final; there is no individual human review.</li>}
          {r.degraded && <li><b>Simplified scoring:</b> one of the three grading stages could not run, so the score was settled with fewer checks than usual.</li>}
        </ul>
        {r.notices.map((n) => <p key={n} className="tr-small tr-muted">{n}</p>)}
        {r.answerSeconds !== null && <p className="tr-small tr-muted">Answered in {fmtDuration(r.answerSeconds)} (from when the question was shown; shown for information, not scored).</p>}
      </div>
    </section>
    <section className="tr-card"><h2 className="tr-h3">Score breakdown</h2>
      <div className="ar-dims">{r.dimensions.map((d) => <div key={d.key} className="ar-dim">
        <div className="ar-dim-head"><span>{d.label}</span><span className="tr-mono">{d.score} / {d.weight}</span></div>
        <div className="tr-bar" aria-hidden="true"><i style={{ width: `${d.weight ? Math.min(100, (d.score / d.weight) * 100) : 0}%` }} /></div>
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
    <div className="ar-actions">
      <button type="button" className="tr-btn tr-btn-primary" disabled={moving} onClick={next}>{moving ? 'Opening…' : nextReady ? 'Next question (ready)' : 'Next question'}</button>
      <span className="tr-small tr-muted ar-next-hint">{nextReady ? `A new ${item.difficulty} architecture and question are ready.` : nextOnDemand ? 'The next architecture and question are generated when you continue (about a minute).' : 'The next architecture and question are being prepared in the background.'}</span>
      <button type="button" className="tr-btn tr-btn-secondary ar-end" disabled={ending} onClick={end}>{ending ? 'Ending…' : 'End assessment'}</button>
      <a className="tr-btn tr-btn-ghost" href={`${BASE}domains/${domainSlug}`} onClick={(e) => { e.preventDefault(); go(`${BASE}domains/${domainSlug}`); }}>Back to domain</a>
    </div>
  </div>;
}

/* ---------------- Session summary (after End assessment) ---------------- */

export function SummaryPage({ go }: { go: (to: string) => void }) {
  useTabTitle('Assessment summary');
  const params = new URLSearchParams(location.search);
  const domain = params.get('domain') ?? '';
  const since = params.get('since') ?? new Date(0).toISOString();
  const [items, setItems] = useState<AttemptSummary[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      // Pages of history until the session's start: the session is every attempt from then on in this domain.
      const all: AttemptSummary[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const l = await reasoning.list(cursor);
        all.push(...l.items);
        const last = l.items[l.items.length - 1];
        if (!l.nextCursor || (last && last.createdAt < since)) break;
        cursor = l.nextCursor;
      }
      setItems(all.filter((a) => a.createdAt >= since && (!domain || a.domain === domain)).reverse());
      setErr(null);
    } catch (e) { if (!(e instanceof ApiError && e.status === 401)) setErr(e); }
  }, [domain, since]);
  useEffect(() => { load(); }, [load]);
  // Answers still being evaluated finish in the background; keep the summary current.
  const pending = items?.some((a) => a.state === 'evaluating') ?? false;
  useEffect(() => { if (!pending) return undefined; const t = window.setInterval(load, 4000); return () => window.clearInterval(t); }, [pending, load]);
  const evaluated = items?.filter((a) => a.state === 'evaluated' && a.totalScore !== null) ?? [];
  // Same rule as the server's statistics: a skipped question that was shown counts as answered with 0.
  const skipped = items?.filter(countsAsSkipped).length ?? 0;
  const counted = evaluated.length + skipped;
  const avg = counted ? Math.round(evaluated.reduce((n, a) => n + (a.totalScore ?? 0), 0) / counted) : null;
  const best = evaluated.length ? Math.max(...evaluated.map((a) => a.totalScore ?? 0)) : null;
  const correct = evaluated.filter((a) => a.correct).length;
  const titleOf = useDomainTitles();
  const title = domain ? titleOf(domain) : 'Attack Reasoning';
  return <>
    <section className="tr-page-head"><div className="tr-wrap"><Crumbs items={[{ label: 'All domains', to: BASE, go }, ...(domain ? [{ label: title, to: `${BASE}domains/${DOMAIN_SLUG(domain)}`, go }] : []), { label: 'Assessment summary' }]} />
      <div className="tr-page-head-in"><div><span className="tr-eyebrow">Assessment ended · {title}</span><h1 className="tr-h1">Your assessment summary</h1><p className="tr-lead">Started {fmtDate(since)}. Every question you answered in this assessment, with its score.</p></div></div></div></section>
    <div className="tr-wrap tr-section">
      {err ? <Err e={err} onRetry={load} /> : null}
      {!items && !err && <Loading text="Loading your assessment…" />}
      {items && <>
        <div className="ar-stats">
          <div className="tr-card"><span className="tr-eyebrow">Answered</span><b className="tr-h2">{evaluated.length}</b><span className="tr-small tr-muted">{pending ? 'some still evaluating' : `${skipped} skipped`}</span></div>
          <div className="tr-card"><span className="tr-eyebrow">Average score</span><b className="tr-h2">{avg ?? '—'}</b><span className="tr-small tr-muted">best {best ?? '—'}{skipped > 0 && ' · skipped count as 0'}</span></div>
          <div className="tr-card"><span className="tr-eyebrow">Correct decisions</span><b className="tr-h2">{counted ? `${correct} / ${counted}` : '—'}</b><span className="tr-small tr-muted">{counted ? `${Math.round((correct / counted) * 100)}%` : 'no answers yet'}</span></div>
          <div className="tr-card"><span className="tr-eyebrow">Trend</span>{evaluated.length > 1 ? <Spark values={evaluated.map((a) => a.totalScore ?? 0)} /> : <span className="tr-small tr-muted">Answer two or more to see a trend.</span>}</div>
        </div>
        <section className="tr-card"><h2 className="tr-h3">Questions in this assessment</h2>
          {items.length === 0 ? <p className="tr-muted">No questions were answered in this assessment.</p> : <AttemptsTable label="Questions in this assessment" head={['#', 'Scenario', 'Level', 'State', 'Score']} rows={items.map((a, i) => ({ key: a.id, cells: [{ node: i + 1, cls: 'tr-mono' }, { node: <a className="ar-link" href={`${BASE}attempts/${a.id}`} onClick={(e) => { e.preventDefault(); go(`${BASE}attempts/${a.id}`); }}>{a.title ?? 'Scenario'}</a>, cls: 'ar-cell-title' }, { node: cap(a.difficulty ?? ''), cls: 'tr-small' }, { node: <StateTag state={a.state} /> }, { node: scoreCell(a), cls: 'tr-mono' }] }))} />}
          {skipped > 0 && <p className="tr-small tr-muted">{SKIP_RULE}</p>}
          {pending && <p className="tr-small tr-muted">Answers marked Evaluating are still being graded; this page updates when they finish.</p>}
        </section>
        <div className="ar-actions">
          {domain && <a className="tr-btn tr-btn-primary" href={`${BASE}domains/${DOMAIN_SLUG(domain)}`} onClick={(e) => { e.preventDefault(); go(`${BASE}domains/${DOMAIN_SLUG(domain)}`); }}>Start a new assessment</a>}
          <a className="tr-btn tr-btn-secondary" href={`${BASE}history`} onClick={(e) => { e.preventDefault(); go(`${BASE}history`); }}>All history</a>
          <a className="tr-btn tr-btn-ghost" href={BASE} onClick={(e) => { e.preventDefault(); go(BASE); }}>All domains</a>
        </div>
      </>}
    </div>
  </>;
}

/* ---------------- History and analytics ---------------- */

export function HistoryPage({ go }: { go: (to: string) => void }) {
  useTabTitle('Your assessments');
  const titleOf = useDomainTitles();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [items, setItems] = useState<AttemptSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = useCallback(() => { setErr(null); Promise.all([reasoning.dashboard(), reasoning.list()]).then(([d, l]) => { setDash(d); setItems(l.items); setCursor(l.nextCursor); }, (e) => { if (!(e instanceof ApiError && e.status === 401)) setErr(e); }); }, []);
  useEffect(load, [load]);
  const [loadingMore, setLoadingMore] = useState(false); const [moreErr, setMoreErr] = useState<unknown>(null);
  const more = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true); setMoreErr(null);
    try { const l = await reasoning.list(cursor); setItems((x) => [...x, ...l.items]); setCursor(l.nextCursor); }
    catch (e) { if (!(e instanceof ApiError && e.status === 401)) setMoreErr(e); }
    finally { setLoadingMore(false); }
  };
  return <>
    <section className="tr-page-head"><div className="tr-wrap"><Crumbs items={[{ label: 'All domains', to: BASE, go }, { label: 'History' }]} /><div className="tr-page-head-in"><div><span className="tr-eyebrow">Attack Reasoning Lab</span><h1 className="tr-h1">Your assessments</h1><p className="tr-lead">Every attempt, its score and how your reasoning is trending across dimensions.</p></div></div></div></section>
    <div className="tr-wrap tr-section">
      {err ? <Err e={err} onRetry={load} /> : null}
      {!dash && !err && <Loading text="Loading history…" />}
      {dash && <>
        <div className="ar-stats">
          <div className="tr-card"><span className="tr-eyebrow">Evaluated</span><b className="tr-h2">{dash.evaluated}</b><span className="tr-small tr-muted">of {dash.attempts} attempts{dash.skipped > 0 && ` · ${dash.skipped} skipped`}</span></div>
          <div className="tr-card"><span className="tr-eyebrow">Average score</span><b className="tr-h2">{dash.averageScore ?? '—'}</b><span className="tr-small tr-muted">best {dash.bestScore ?? '—'}{dash.skipped > 0 && ' · skipped count as 0'}</span></div>
          <div className="tr-card"><span className="tr-eyebrow">Correct decisions</span><b className="tr-h2">{dash.correctRate === null ? '—' : `${Math.round(dash.correctRate * 100)}%`}</b><span className="tr-small tr-muted">{dash.inProgress} in progress</span></div>
          <div className="tr-card"><span className="tr-eyebrow">Trend</span>{dash.scoreHistory.length > 1 ? <Spark values={dash.scoreHistory.map((s) => s.score)} /> : <span className="tr-small tr-muted">Complete two assessments to see a trend.</span>}</div>
        </div>
        <div className="ar-two">
          <section className="tr-card"><h2 className="tr-h3">By dimension</h2><div className="ar-dims">{dash.dimensionAverages.map((d) => <div key={d.key} className="ar-dim"><div className="ar-dim-head"><span>{d.label}</span><span className="tr-mono">{d.average === null ? '—' : `${d.average}%`}</span></div><div className="tr-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, d.average ?? 0)}%` }} /></div></div>)}</div><p className="tr-small tr-muted">Average share of each dimension's points earned across evaluated attempts.</p></section>
          <section className="tr-card"><h2 className="tr-h3">By domain</h2>{dash.byDomain.length ? <table className="ar-table"><thead><tr><th>Domain</th><th>Evaluated</th><th>Average</th><th>Best</th></tr></thead><tbody>{dash.byDomain.map((d) => <tr key={d.domain}><td><a className="ar-link" href={`${BASE}domains/${DOMAIN_SLUG(d.domain)}`} onClick={(e) => { e.preventDefault(); go(`${BASE}domains/${DOMAIN_SLUG(d.domain)}`); }}>{d.title}</a></td><td className="tr-mono">{d.stats.evaluated}</td><td className="tr-mono">{d.stats.averageScore ?? '—'}</td><td className="tr-mono">{d.stats.bestScore ?? '—'}</td></tr>)}</tbody></table> : <p className="tr-muted">No attempts yet.</p>}</section>
        </div>
        <section className="tr-card"><h2 className="tr-h3">All attempts</h2>
          {items.length === 0 ? <p className="tr-muted">No attempts yet. <a className="ar-link" href={BASE} onClick={(e) => { e.preventDefault(); go(BASE); }}>Choose a domain</a> to start.</p> : <AttemptsTable label="All attempts" head={['Scenario', 'Domain', 'State', 'Score', 'When']} rows={items.map((a) => ({ key: a.id, cells: [{ node: <a className="ar-link" href={`${BASE}attempts/${a.id}`} onClick={(e) => { e.preventDefault(); go(`${BASE}attempts/${a.id}`); }}>{a.title ?? 'Scenario'}</a>, cls: 'ar-cell-title' }, { node: titleOf(a.domain), cls: 'tr-small' }, { node: <StateTag state={a.state} /> }, { node: scoreCell(a), cls: 'tr-mono' }, { node: fmtDate(a.createdAt), cls: 'tr-small' }] }))} />}
          {cursor && <div className="ar-load-more"><button type="button" className="tr-btn tr-btn-secondary tr-btn-sm" disabled={loadingMore} onClick={more}>{loadingMore ? 'Loading…' : 'Load more'}</button>{loadingMore && <span className="tr-small tr-muted" role="status">Loading more attempts…</span>}</div>}
          {moreErr ? <Err e={moreErr} onRetry={more} /> : null}
        </section>
      </>}
    </div>
  </>;
}

function Spark({ values }: { values: number[] }) {
  const w = 160; const h = 44;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / 100) * h}`).join(' ');
  return <svg className="ar-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`Scores, oldest first: ${values.join(', ')}`}><polyline fill="none" stroke="currentColor" strokeWidth="2" points={pts} /></svg>;
}
