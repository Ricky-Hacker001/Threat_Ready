import { useState, type KeyboardEvent } from 'react';
import {
  BookOpen, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Eye, FlaskConical, Lightbulb, List, Lock,
  PanelRightClose, PanelRightOpen, Play, RotateCcw, TriangleAlert, XCircle, Award, Home, NotebookText,
} from 'lucide-react';
import { useStore } from '../state/store';
import { ui, useUi } from '../state/ui';
import { TASKS } from '../tasks';
import { LEVELS, type TaskDef } from '../tasks/types';
import { currentStep } from './current';
import { blankProgress } from '../tasks/runtime';
import type { TaskProgress } from '../state/types';
import { BadgeShield, BADGE_DISCLAIMER } from '../brand/Brand';
import { levelSummary } from '../brand/progress';

const MODES = ['guided', 'practice'] as const;

const STATUS_LABEL: Record<string, string> = {
  locked: 'Locked', available: 'Available', 'in-progress': 'In progress', completed: 'Completed', stale: 'Re-verify',
};

function StatusIcon({ st }: { st: TaskProgress['status'] }) {
  if (st === 'completed') return <CheckCircle2 size={15} color="var(--tw-ok)" />;
  if (st === 'stale') return <TriangleAlert size={15} color="var(--tw-warn)" />;
  if (st === 'in-progress') return <CircleDot size={15} color="var(--tw-accent)" />;
  if (st === 'locked') return <Lock size={14} color="var(--text-3)" />;
  return <Play size={13} color="var(--tw-info)" />;
}

export function TaskPanel() {
  const { state, setProgress, emit, update, addAudit } = useStore();
  const u = useUi();
  const p = state.progress;
  const [listOpen, setListOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(true);
  const task = TASKS.find((t) => t.id === p.current) ?? TASKS[0];
  const tp = p.tasks[task.id] ?? blankProgress();
  const cur = currentStep(state, u, TASKS);
  const done = TASKS.filter((t) => p.tasks[t.id]?.status === 'completed').length;

  if (!p.panelOpen) {
    return (
      <aside className="tw-panel collapsed" aria-label="Training panel (collapsed)">
        <button className="tw-panel-iconbtn" onClick={() => setProgress((x) => ({ ...x, panelOpen: true }))} aria-label="Open training panel" title="Open training panel"><PanelRightOpen size={18} /></button>
        <button className="tw-panel-iconbtn" onClick={() => (u.labOpen ? ui.closeLab() : ui.openLab())} aria-label="Lab Tools" title="Lab Tools"><FlaskConical size={18} /></button>
        <div className="tw-panel-vert">{task.id} · {done}/{TASKS.length}</div>
      </aside>
    );
  }

  const select = (t: TaskDef) => {
    const st = p.tasks[t.id]?.status ?? 'locked';
    if (st === 'locked') return;
    setProgress((x) => ({ ...x, current: t.id }));
    setListOpen(false);
  };

  const restart = () => {
    setProgress((x) => ({ ...x, tasks: { ...x.tasks, [task.id]: { ...blankProgress(), status: 'in-progress', startedAt: Date.now() } } }));
  };

  const startScenario = () => {
    if (!task.scenario) return;
    update((s) => {
      const n = task.scenario!.apply(s);
      return {
        ...n,
        lab: { ...n.lab, scenarios: { ...n.lab.scenarios, [task.id]: Date.now() } },
        progress: { ...n.progress, current: task.id, tasks: { ...n.progress.tasks, [task.id]: { ...blankProgress(), status: 'in-progress', startedAt: Date.now() } } },
      };
    });
    addAudit([{ category: 'Lab', action: `Lab scenario started: ${task.id}`, detail: task.scenario.label }]);
  };

  // Radio group keyboard pattern: one tab stop; arrow keys move to and select the other mode.
  const onModeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = MODES[(MODES.indexOf(p.mode) + delta + MODES.length) % MODES.length];
    setProgress((x) => ({ ...x, mode: next }));
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
  };

  const step = cur.task?.id === task.id ? cur.step : null;
  const hint = step && cur.ctx && step.hint ? safe(() => step.hint!(cur.ctx!)) : null;
  const lastFail = tp.failures.length ? tp.failures[tp.failures.length - 1] : null;
  // A recorded failure is shown until the learner's draft changes it away (the live hint then takes over).
  const showFail = lastFail && step && lastFail.stepId === step.id && hint ? hint : null;
  const practice = p.mode === 'practice';
  const revealed = !practice || u.reveal === step?.id;

  return (
    <aside className="tw-panel" aria-label="Training panel">
      <div className="tw-panel-head">
        <span className="tr-panel-word" aria-label="ThreatReady">ThreatReady</span>
        <button className="tw-panel-title" onClick={() => setListOpen((v) => !v)} aria-expanded={listOpen}>
          <span title={`Task ${task.id}: show all tasks`}>{task.id}</span>{listOpen ? <ChevronDown size={14} /> : <List size={14} />}
        </button>
        <span className="tw-panel-count" title="Tasks completed">{done}/{TASKS.length}</span>
        <a className="tw-panel-iconbtn" href="#/start" aria-label="ThreatReady home" title="Home: levels, progress, reset"><Home size={17} /></a>
        <a className="tw-panel-iconbtn" href={`#/notebook/${task.id}`} aria-label={`Learning notebook: lesson ${task.id}`} title="Learning notebook: the full lesson for this task"><NotebookText size={17} /></a>
        <a className="tw-panel-iconbtn" href="#/record" data-guide="open-record" aria-label="Training record" title="Training record"><Award size={17} /></a>
        <button className="tw-panel-iconbtn" onClick={() => (u.labOpen ? ui.closeLab() : ui.openLab())} aria-label="Lab Tools" title="Lab Tools"><FlaskConical size={17} /></button>
        <button className="tw-panel-iconbtn" onClick={() => setProgress((x) => ({ ...x, panelOpen: false }))} aria-label="Collapse training panel" title="Collapse"><PanelRightClose size={17} /></button>
      </div>

      <div className="tw-panel-modes">
        <div className="tw-seg" role="radiogroup" aria-label="Learning mode" onKeyDown={onModeKey}>
          {MODES.map((m) => (
            <button key={m} role="radio" aria-checked={p.mode === m} tabIndex={p.mode === m ? 0 : -1} data-mode={m} className={p.mode === m ? 'on' : ''} onClick={() => setProgress((x) => ({ ...x, mode: m }))}>
              {m === 'guided' ? 'Guided' : 'Practice'}
            </button>
          ))}
        </div>
        <label className="tw-beginner"><input type="checkbox" checked={p.beginner} onChange={(e) => setProgress((x) => ({ ...x, beginner: e.target.checked }))} /> Beginner explanations</label>
      </div>

      {listOpen ? (
        <div className="tw-panel-body">
          {LEVELS.map((lv) => {
            const tasks = TASKS.filter((t) => t.level === lv.id);
            const n = tasks.filter((t) => p.tasks[t.id]?.status === 'completed').length;
            return (
              <section key={lv.id} className="tw-lv">
                <h3>{lv.name} <span>{n}/{tasks.length}</span></h3>
                <p>{lv.tagline}</p>
                <ul>
                  {tasks.map((t) => {
                    const st = p.tasks[t.id]?.status ?? 'locked';
                    return (
                      <li key={t.id}>
                        <button disabled={st === 'locked'} className={t.id === task.id ? 'cur' : ''} onClick={() => select(t)} title={STATUS_LABEL[st]}>
                          <StatusIcon st={st} /><span className="id">{t.id}</span><span className="tt">{t.title}</span><span className="min">{t.minutes}m</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          <a className="tw-report-link" href="#/record">
            <Award size={15} /> Training record {done === TASKS.length ? '(track complete)' : `(${done} of ${TASKS.length} verified so far)`}
          </a>
        </div>
      ) : (
        <div className="tw-panel-body">
          <BadgeCard />
          <div className="tw-task-head">
            <span className="tw-lvl">{LEVELS[task.level].name.split(' — ')[0]} · {task.difficulty} · ~{task.minutes} min</span>
            <h2>{task.id} — {task.title}</h2>
            <div className="tw-task-meta">
              <span className={`tw-pill ${tp.status === 'completed' ? 'ok' : tp.status === 'stale' ? 'warn' : tp.status === 'locked' ? 'muted' : 'info'}`}>{STATUS_LABEL[tp.status]}</span>
              {tp.status === 'in-progress' ? <span className="muted">Step {Math.min(tp.step + 1, task.steps.length)} of {task.steps.length}</span> : null}
              {tp.status !== 'locked' && tp.startedAt ? <button className="tw-linkbtn" onClick={restart} title="Restart this task's steps (configuration is kept)"><RotateCcw size={12} /> Restart steps</button> : null}
            </div>
            <div className="tw-progress"><div style={{ width: `${(Math.min(tp.step, task.steps.length) / task.steps.length) * 100}%` }} /></div>
          </div>

          <button className="tw-collapse" onClick={() => setAboutOpen((v) => !v)} aria-expanded={aboutOpen}>
            {aboutOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} About this task
          </button>
          {aboutOpen && <a className="tw-lesson-link" href={`#/notebook/${task.id}`}><NotebookText size={13} /> Read the full lesson for {task.id} in the learning notebook</a>}
          {aboutOpen && (
            <dl className="tw-five">
              <dt>What it is</dt><dd>{task.what}</dd>
              <dt>What we do</dt><dd>{task.whatWeDo}</dd>
              <dt>Why</dt><dd>{task.why}</dd>
              {task.prerequisites.length ? <><dt>Prerequisites</dt><dd>{task.prerequisites.join(' · ')}</dd></> : null}
              {task.expected.length && practice ? <><dt>Expected values</dt><dd className="muted">Hidden in Practice mode. Use <b>Hint</b> on a step if you are stuck.</dd></> : task.expected.length ? (
                <><dt>Expected values</dt><dd><table className="tw-exp"><tbody>{task.expected.map((e) => <tr key={e.label}><th>{e.label}</th><td className="mono">{e.value}</td></tr>)}</tbody></table></dd></>
              ) : null}
            </dl>
          )}

          {tp.status === 'locked' && <div className="tw-note warn"><Lock size={14} /><div>Complete the previous task first. Tasks unlock in order; levels unlock when every task in the level is complete.</div></div>}

          {task.scenario && tp.status === 'available' && (
            <div className="tw-step cur">
              <div className="tw-step-title">Start the lab scenario</div>
              <p>{task.scenario.label}</p>
              <button className="tw-btn tw-btn-primary" onClick={startScenario}><Play size={12} /> Start scenario</button>
            </div>
          )}

          {(tp.status === 'in-progress' || tp.status === 'completed' || tp.status === 'stale') && (
            <ol className="tw-steps">
              {task.steps.map((st, i) => {
                const isDone = i < tp.step || tp.status !== 'in-progress';
                const isCur = tp.status === 'in-progress' && i === tp.step;
                if (!isDone && !isCur) return null;
                return (
                  <li key={st.id} className={`tw-step${isDone ? ' done' : ''}${isCur ? ' cur' : ''}`}>
                    <div className="tw-step-title">
                      <span className="n">{isDone ? <Check size={12} /> : i + 1}</span>
                      <span>{st.title}</span>
                    </div>
                    {isCur && (
                      <div className="tw-step-body">
                        {revealed && st.expect ? <div className="tw-expect"><span>Value</span><code>{st.expect}</code></div> : null}
                        {st.why ? <p className="tw-why"><b>Why:</b> {st.why}</p> : null}
                        {p.beginner && st.beginner ? <p className="tw-beg"><BookOpen size={13} /> {st.beginner}</p> : null}
                        {showFail ? <div className="tw-fail" role="alert"><XCircle size={14} /> <span>{showFail} <i>Validation failed for this step — correct the value and try again.</i></span></div>
                          : hint ? <div className="tw-pending" role="status"><TriangleAlert size={14} /> <span>Not yet: {hint}</span></div> : null}
                        <div className="tw-step-actions">
                          {st.info ? <button className="tw-btn tw-btn-primary" onClick={() => emit('ack', { step: st.id })}>Got it</button> : null}
                          {st.prefill ? <button className="tw-btn" onClick={() => { ui.openLab('traffic'); ui.setDraft('lt-prefill', { ...st.prefill, n: Date.now() }); }}>Load this test</button> : null}
                          {practice && !revealed ? <button className="tw-btn" onClick={() => ui.setReveal(st.id)}><Lightbulb size={12} /> Hint</button> : null}
                          {revealed && (st.target || st.route || st.lab) ? <button className="tw-btn" onClick={() => ui.flashGuide()}><Eye size={12} /> Show me</button> : null}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
              {tp.status === 'in-progress' && tp.step < task.steps.length - 1 ? (
                <li className="tw-step later">{task.steps.length - tp.step - 1} more step(s)</li>
              ) : null}
            </ol>
          )}

          {task.notes && tp.status !== 'locked' && (
            <div className="tw-notes">
              {task.notes.map((n) => (
                <label key={n.key}>
                  <span>{n.label}</span>
                  <textarea rows={n.rows ?? 3} placeholder={n.placeholder} value={p.notes[n.key] ?? ''}
                    onChange={(e) => setProgress((x) => ({ ...x, notes: { ...x.notes, [n.key]: e.target.value } }))} data-guide={`note:${n.key}`} />
                </label>
              ))}
            </div>
          )}

          {(tp.status === 'in-progress' && tp.step >= task.steps.length) || tp.status === 'completed' || tp.status === 'stale' ? (
            <section className="tw-verify">
              <h3>Verification</h3>
              <p className="muted">{task.verify}</p>
              <ul>
                {tp.checks.map((c) => {
                  const label = task.checks.find((x) => x.id === c.id)?.label ?? c.id;
                  return (
                    <li key={c.id} className={c.ok ? 'ok' : 'bad'}>
                      {c.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                      <span><b>{label}</b>{!c.ok || p.beginner ? <><br /><span className="d">{c.detail}</span></> : null}</span>
                    </li>
                  );
                })}
              </ul>
              {tp.status === 'stale' ? <div className="tw-note warn"><TriangleAlert size={14} /><div>A later change broke a check this task had passed. Fix it to re-verify.</div></div> : null}
              {tp.status === 'completed' ? (
                <div className="tw-done">
                  <CheckCircle2 size={18} /> Task complete
                  {(() => {
                    const idx = TASKS.findIndex((t) => t.id === task.id);
                    const nx = TASKS[idx + 1];
                    return nx && p.tasks[nx.id]?.status !== 'locked' ? <button className="tw-btn tw-btn-primary" onClick={() => select(nx)}>Next: {nx.id} {nx.title}</button> : null;
                  })()}
                </div>
              ) : null}
            </section>
          ) : null}

          <details className="tw-more">
            <summary>Common mistakes and troubleshooting</summary>
            <h4>Common mistakes</h4>
            <ul>{task.mistakes.map((m) => <li key={m}>{m}</li>)}</ul>
            <h4>Troubleshooting</h4>
            <ul>{task.troubleshooting.map((m) => <li key={m}>{m}</li>)}</ul>
          </details>
        </div>
      )}
    </aside>
  );
}

/** Non-blocking card shown once per level when its last task is verified. */
function BadgeCard() {
  const { progress: p, setProgress } = useStore();
  const lv = LEVELS.find((l) => !p.badgesSeen.includes(l.id) && levelSummary(p, l.id).state === 'complete');
  if (!lv) return null;
  const sum = levelSummary(p, lv.id);
  const nextLv = LEVELS[lv.id + 1];
  return (
    <div className="tr-badgecard" role="status" data-guide="badge-card">
      <BadgeShield level={lv.id} size={40} />
      <div>
        <h3>{lv.name} badge earned</h3>
        <p>{sum.done} of {sum.total} tasks verified{sum.fails ? ` · ${sum.fails} failed attempt${sum.fails === 1 ? '' : 's'} corrected` : ' · no failed attempts'}</p>
        <p>{nextLv ? `${nextLv.name} is now open.` : 'All five levels completed. Your internal Level 4 badge has been earned.'}</p>
        <p className="disc">{BADGE_DISCLAIMER}</p>
        <button className="tr-btn" onClick={() => setProgress((x) => ({ ...x, badgesSeen: [...x.badgesSeen, lv.id] }))}>Close</button>
      </div>
    </div>
  );
}

function safe<T>(f: () => T): T | null { try { return f(); } catch { return null; } }
