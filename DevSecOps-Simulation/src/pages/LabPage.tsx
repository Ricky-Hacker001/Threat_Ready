import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { LabDef, Mode } from '../engine/lab';
import { activeMs, createLabState, score, settle, wallMs } from '../engine/lab';
import type { LabState } from '../engine/types';
import { runLine, type ShellCtx } from '../engine/shell';
import { ancestry, status } from '../engine/git';
import { findWorkflow } from '../engine/pipeline';
import { revOf } from '../engine/shell';
import { clearLabState, loadLabState, saveLabState, type Progress } from '../store';
import { LABS } from '../content/labs';
import { cartSourcesOf, prepareCartTests } from '../content/aeroshop';
import { canOpen } from './Dashboard';
import { Editor } from '../components/Editor';
import { FileTree } from '../components/FileTree';
import { Terminal, type TerminalHandle } from '../components/Terminal';
import { Findings } from '../components/Findings';
import { PipelineView } from '../components/PipelineView';
import { TaskPanel } from '../components/TaskPanel';
import { Ansi } from '../components/Ansi';
import { Modal } from '../components/Modal';
import { SmallScreenNotice } from '../components/SmallScreenNotice';
import { IdentityNotice } from '../components/IdentityNotice';

type Tab = 'terminal' | 'findings' | 'pipeline' | 'git' | 'activity';
const TABS: Tab[] = ['terminal', 'findings', 'pipeline', 'git', 'activity'];

interface Props {
  def: LabDef;
  mode: Mode;
  progress: Progress;
  update: (fn: (p: Progress) => Progress) => void;
  go: (r: string) => void;
}

function fmtTime(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Gate: a locked lab shows a message and nothing else. The workspace (and its effects, which create and save lab
 * state) only mounts for a lab the learner may open (FUNC-14).
 */
export function LabPage(props: Props) {
  const { def, progress, go } = props;
  if (!canOpen(def.id, progress))
    return (
      <div className="page">
        <IdentityNotice />
        <main className="wrap section">
          <h1 className="pagetitle">
            <span aria-hidden="true">🔒 </span>
            {def.title} is locked
          </h1>
          <p className="sub">Complete the previous lab first, or switch to Expert mode on the dashboard to unlock everything.</p>
          <button className="btn primary" onClick={() => go('/labs')}>
            Back to my labs
          </button>
        </main>
      </div>
    );
  return <LabWorkspace {...props} />;
}

function LabWorkspace({ def, mode: dashboardMode, update, go }: Props) {
  // Each attempt keeps the mode it was started in (UX-14); older saves adopt the current mode once.
  const [initial] = useState<LabState>(() => {
    const st = loadLabState(def.id) ?? createLabState(def);
    if (!st.mode) st.mode = dashboardMode;
    return st;
  });
  const stateRef = useRef<LabState>(initial);
  const s = stateRef.current;
  const mode: Mode = s.mode ?? dashboardMode;
  const [, setTick] = useState(0);
  const [termKey, setTermKey] = useState(0);
  const [active, setActive] = useState<string | null>(s.files[def.openFile] !== undefined ? def.openFile : Object.keys(s.files)[0] ?? null);
  const [tab, setTab] = useState<Tab>('terminal');
  const [toasts, setToasts] = useState<{ id: number; text: string; ok: boolean }[]>([]);
  const [animating, setAnimating] = useState<{ id: number; start: number } | null>(null);
  const [jump, setJump] = useState<{ line: number; n: number } | null>(null);
  const [showCommit, setShowCommit] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [bottomPct, setBottomPct] = useState(42);
  const [now, setNow] = useState(Date.now());
  const term = useRef<TerminalHandle>(null);
  const center = useRef<HTMLElement>(null);
  const env = useRef<Record<string, string>>({ HOME: '/home/devsecops', USER: 'devsecops', NODE_ENV: 'development' });
  const settleTimer = useRef<number | undefined>(undefined);

  const toast = useCallback((text: string, ok = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, ok }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const finish = useCallback(
    (st: LabState) => {
      const m: Mode = st.mode ?? dashboardMode;
      const sc = score(def, st, m);
      // Both clocks are recorded: wall-clock time is what the speed bonus measured, active time is for information.
      const minutes = Math.round(wallMs(st) / 60000);
      const activeMinutes = Math.round(activeMs(st) / 60000);
      update((p) => {
        const prev = p.results[def.id];
        if (prev && prev.score >= sc.score) return p;
        return { ...p, results: { ...p.results, [def.id]: { score: sc.score, max: sc.max, mode: m, minutes, activeMinutes, completedAt: st.completedAt ?? Date.now() } } };
      });
      setShowDone(true);
    },
    [def, dashboardMode, update],
  );

  /** Re-evaluate the lab after any action. */
  const afterAction = useCallback(() => {
    const st = stateRef.current;
    const wasComplete = !!st.completedAt;
    const { newlyAchieved, run } = settle(def, st);
    for (const id of newlyAchieved) {
      const o = def.objectives.find((x) => x.id === id)!;
      toast(`${o.bonus ? 'Bonus' : 'Objective'} complete: ${o.title}`, true);
    }
    if (run) {
      setAnimating({ id: run.id, start: Date.now() });
      toast(`Pipeline #${run.id} started for ${run.commit.slice(0, 7)} — see the Pipeline tab`);
    }
    saveLabState(st);
    setTick((t) => t + 1);
    if (!wasComplete && st.completedAt) setTimeout(() => finish(st), run ? 2500 : 600);
  }, [def, finish, toast]);

  const execute = useCallback(
    async (cmd: string) => {
      const st = stateRef.current;
      // The unit tests run the learner's cart.js in a sandbox ahead of time; make sure every version this
      // command could test (working tree, commits) has been evaluated before the synchronous engine runs.
      await prepareCartTests(cartSourcesOf(st));
      const ctx: ShellCtx = { s: st, fs: st.files, installed: st.installed, pipeline: false, env: env.current, flags: st.flags, tests: def.tests, commit: st.head };
      const r = runLine(cmd, ctx);
      st.activity.push({ t: Date.now(), kind: /^git /.test(cmd) ? 'git' : 'cmd', text: `$ ${cmd}${r.code ? `  (exit ${r.code})` : ''}` });
      if (st.activity.length > 400) st.activity.splice(0, st.activity.length - 400);
      if (active && st.files[active] === undefined) setActive(Object.keys(st.files).find((f) => f === def.openFile) ?? Object.keys(st.files)[0] ?? null);
      afterAction();
      return r;
    },
    [active, afterAction, def],
  );

  // Time away (tab hidden, lab closed or left for the dashboard) does not count towards the active time (UX-14), which
  // is shown for information. The Expert speed bonus runs on wall-clock time (SEC-3), since time away can still be
  // spent on the lab. Declared before the first save so a gap since the last visit is accounted for.
  useEffect(() => {
    const back = () => {
      const st = stateRef.current;
      if (!st.awayAt) return;
      if (!st.completedAt) st.pausedMs = (st.pausedMs ?? 0) + Math.max(0, Date.now() - st.awayAt);
      st.awayAt = null;
      saveLabState(st);
      setNow(Date.now());
    };
    const leave = () => {
      const st = stateRef.current;
      if (st.completedAt || st.awayAt) return;
      st.awayAt = Date.now();
      saveLabState(st);
    };
    const onVis = () => (document.visibilityState === 'hidden' ? leave() : back());
    back();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, []);

  useEffect(() => {
    if (s.completedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [s.completedAt]);

  useEffect(() => {
    afterAction();
    void prepareCartTests(cartSourcesOf(stateRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onEdit = (v: string) => {
    if (!active) return;
    s.files[active] = v;
    setTick((t) => t + 1);
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      s.activity.push({ t: Date.now(), kind: 'edit', text: `edited ${active}` });
      afterAction();
      // Evaluate the edited cart.js once typing settles (one sandbox run per pause, not one per keystroke, UX-REG8);
      // a command run before then evaluates it itself.
      if (active === 'src/lib/cart.js') void prepareCartTests([v]);
    }, 450);
  };

  const newFile = () => {
    const p = window.prompt('New file path (e.g. .dockerignore or .github/workflows/ci.yml)');
    if (!p) return;
    const path = p.replace(/^\.?\//, '');
    if (s.files[path] === undefined) s.files[path] = '';
    setActive(path);
    afterAction();
  };
  const deleteFile = (p: string) => {
    delete s.files[p];
    if (active === p) setActive(s.files[def.openFile] !== undefined ? def.openFile : Object.keys(s.files)[0] ?? null);
    afterAction();
  };

  const gitMarks = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of status(s)) m[e.path] = e.untracked || e.staged === 'A' ? 'U' : 'M';
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, s.files, s.index, s.head, s.activity.length, now]);

  const rev = revOf(s);
  const currentFindings = Object.values(s.scans).flatMap((r) => (r!.rev === rev ? r!.findings : []));
  const findingsByFile: Record<string, number> = {};
  for (const f of currentFindings) if (f.file && s.files[f.file] !== undefined) findingsByFile[f.file] = (findingsByFile[f.file] ?? 0) + 1;
  const allFindings = Object.values(s.scans).flatMap((r) => r!.findings);
  const lastRun = s.pipelineRuns[s.pipelineRuns.length - 1];
  const wf = findWorkflow(s.files);
  const req = def.objectives.filter((o) => !o.bonus);
  const doneN = req.filter((o) => s.achieved.includes(o.id)).length;
  const headDiff = active ? (ancestry(s.commits, s.head)[0]?.files[active] === s.files[active] ? null : ancestry(s.commits, s.head)[0]?.files[active] === undefined ? 'new' : 'modified') : null;

  // Splitter between editor and bottom panel: pointer (mouse, touch, pen) and keyboard (arrows, Home/End).
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const rect = center.current?.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      if (!rect) return;
      setBottomPct(Math.min(80, Math.max(15, ((rect.bottom - ev.clientY) / rect.height) * 100)));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const splitKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 5;
    const next = e.key === 'ArrowUp' ? bottomPct + step : e.key === 'ArrowDown' ? bottomPct - step : e.key === 'Home' ? 80 : e.key === 'End' ? 15 : null;
    if (next === null) return;
    e.preventDefault();
    setBottomPct(Math.min(80, Math.max(15, next)));
  };

  const tabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = TABS.indexOf(tab);
    const n = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault();
    setTab(TABS[n]);
    document.getElementById(`ws-tab-${TABS[n]}`)?.focus();
  };
  const tabProps = (t: Tab) => ({
    id: `ws-tab-${t}`,
    role: 'tab',
    'aria-selected': tab === t,
    'aria-controls': 'ws-tabpanel',
    tabIndex: tab === t ? 0 : -1,
    className: tab === t ? 'on' : '',
    onClick: () => setTab(t),
  });

  const idx = LABS.findIndex((l) => l.id === def.id);
  const nextLab = LABS[idx + 1];
  const sc = score(def, s, mode);
  const elapsed = activeMs(s, now);
  const wall = wallMs(s, now);

  const resetLab = () => {
    if (!window.confirm('Reset this lab? Your changes, scans and pipeline runs in this lab will be discarded, and a fresh attempt starts in the current dashboard mode.')) return;
    clearLabState(def.id);
    const fresh = createLabState(def);
    fresh.mode = dashboardMode;
    stateRef.current = fresh;
    setActive(def.openFile);
    setTermKey((k) => k + 1);
    setAnimating(null);
    afterAction();
  };

  return (
    <div className="ws">
      <header className="wsbar">
        <button className="btn ghost sm" onClick={() => go('/labs')}>
          <span aria-hidden="true">←</span> Labs
        </button>
        <span className="chip">L{def.level}</span>
        <h1 className="title">{def.title}</h1>
        <span className={`chip ${mode === 'guided' ? 'green' : mode === 'standard' ? 'blue' : 'violet'}`} title="Mode of this attempt">
          {mode}
        </span>
        <span className="spacer" />
        <span className="chip green">
          {doneN}/{req.length} objectives
        </span>
        {mode === 'expert' ? (
          <span className="timer" title={`Time since this attempt started, including time away. Finish within ${def.minutes} minutes for the speed bonus. Active time: ${fmtTime(elapsed)}.`}>
            <span aria-hidden="true">⏱ </span>
            <span className="sr">Time since the attempt started: </span>
            {fmtTime(wall)} / {def.minutes}:00
          </span>
        ) : (
          <span className="timer" title="Active time in this lab (paused while you are away)">
            <span aria-hidden="true">⏱ </span>
            <span className="sr">Time in lab: </span>
            {fmtTime(elapsed)}
          </span>
        )}
        <button className="btn sm" onClick={() => setShowCommit(true)}>
          <span aria-hidden="true">⎇ </span>Commit &amp; Push
        </button>
        {s.completedAt && (
          <button className="btn sm primary" onClick={() => setShowDone(true)}>
            Results
          </button>
        )}
        <button className="btn sm ghost" title="Reset this lab to its starting state" onClick={resetLab}>
          <span aria-hidden="true">↺ </span>Reset
        </button>
      </header>
      <IdentityNotice />
      <SmallScreenNotice />

      <main className="wsmain">
        <TaskPanel
          def={def}
          s={s}
          mode={mode}
          dashboardMode={dashboardMode}
          onRun={(c) => {
            setTab('terminal');
            setTimeout(() => term.current?.run(c), 0);
          }}
          onPaste={(c) => {
            setTab('terminal');
            setTimeout(() => term.current?.insert(c), 0);
          }}
          onHint={(key) => {
            if (!s.hintsUsed.includes(key)) s.hintsUsed.push(key);
            s.activity.push({ t: Date.now(), kind: 'hint', text: `hint used (${key})` });
            afterAction();
          }}
        />

        <section className="center" ref={center} aria-label="Code and tools" style={{ '--bottom': `${bottomPct}%` } as React.CSSProperties}>
          <div className="editorarea">
            <FileTree files={Object.keys(s.files)} active={active} marks={gitMarks} findingsByFile={findingsByFile} onOpen={setActive} onNew={newFile} onDelete={deleteFile} />
            <Editor
              path={active && s.files[active] !== undefined ? active : null}
              value={active ? (s.files[active] ?? '') : ''}
              onChange={onEdit}
              findings={currentFindings}
              status={headDiff}
              jumpTo={jump}
              files={Object.keys(s.files)}
              onOpen={setActive}
              onNew={newFile}
              onDelete={deleteFile}
            />
          </div>
          <div
            className="splitter"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the editor and the bottom panel"
            aria-valuemin={15}
            aria-valuemax={80}
            aria-valuenow={Math.round(bottomPct)}
            aria-valuetext={`Bottom panel ${Math.round(bottomPct)}% of the height`}
            tabIndex={0}
            onPointerDown={startDrag}
            onKeyDown={splitKey}
            title="Drag, or use the arrow keys, to resize"
          />
          <div className="bottom">
            <div className="tabs" role="tablist" aria-label="Tools" onKeyDown={tabKey}>
              <button {...tabProps('terminal')}>Terminal</button>
              <button {...tabProps('findings')}>
                Findings {allFindings.length > 0 && <span className="badge red">{allFindings.length}</span>}
              </button>
              <button {...tabProps('pipeline')}>
                Pipeline {lastRun && <span className={`badge ${lastRun.status === 'passed' ? 'green' : 'red'}`}>#{lastRun.id} {lastRun.status}</span>}
              </button>
              <button {...tabProps('git')}>
                Git {Object.keys(gitMarks).length > 0 && <span className="badge">{Object.keys(gitMarks).length}</span>}
              </button>
              <button {...tabProps('activity')}>Activity</button>
            </div>
            {/* tabIndex 0 (APG tabs): Git and Activity hold nothing focusable, and the terminal input takes the arrow keys, so the
                panel itself takes focus for keyboard scrolling (axe scrollable-region-focusable). */}
            <div className="tabbody" id="ws-tabpanel" role="tabpanel" aria-labelledby={`ws-tab-${tab}`} tabIndex={0}>
              <div style={{ display: tab === 'terminal' ? 'block' : 'none', height: '100%' }}>
                <Terminal
                  key={termKey}
                  ref={term}
                  execute={execute}
                  files={Object.keys(s.files)}
                  initial={[
                    `\x1b[1mAeroShop DevSecOps workstation\x1b[0m — lab: ${def.title}`,
                    `\x1b[90mRepository cloned to /workspace/aeroshop-api · type \x1b[0mhelp\x1b[90m for available tools · ↑/↓ history · Tab completion\x1b[0m`,
                    '',
                  ]}
                />
              </div>
              {tab === 'findings' && (
                <Findings
                  s={s}
                  onJump={(file, line) => {
                    setActive(file);
                    setJump({ line, n: Date.now() });
                  }}
                />
              )}
              {tab === 'pipeline' && (
                <PipelineView
                  runs={s.pipelineRuns}
                  animating={animating}
                  workflowPath={wf}
                  onOpenWorkflow={() => wf && setActive(wf)}
                  onViewFailedLog={() => {
                    if (!s.flags.viewedFailedLog) {
                      s.flags.viewedFailedLog = true;
                      afterAction();
                    }
                  }}
                />
              )}
              {tab === 'git' && <GitPanel s={s} onOpen={setActive} />}
              {tab === 'activity' && (
                <div className="activity">
                  {[...s.activity].reverse().map((a, i) => (
                    <div key={i}>
                      <time>{new Date(a.t).toLocaleTimeString()}</time>
                      <span style={{ color: a.kind === 'objective' ? 'var(--accent-text)' : a.kind === 'pipeline' ? 'var(--blue)' : a.kind === 'hint' ? 'var(--amber)' : undefined }}>{a.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      {showCommit && (
        <CommitDialog
          s={s}
          onClose={() => setShowCommit(false)}
          onCommit={(msg, push) => {
            setShowCommit(false);
            setTab('terminal');
            const safe = msg.replace(/"/g, "'");
            setTimeout(() => term.current?.run(`git add -A && git commit -m "${safe}"${push ? ' && git push' : ''}`), 0);
          }}
        />
      )}

      {showDone && (
        <Modal title={def.title} onClose={() => setShowDone(false)}>
          <span className="chip green">Lab complete</span>
          <div style={{ display: 'flex', gap: 24, alignItems: 'baseline', margin: '10px 0', flexWrap: 'wrap' }}>
            <div>
              <div className="big">{sc.score}</div>
              <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>points (max {sc.max})</div>
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 13.5 }}>
              <span aria-hidden="true">⏱ </span>
              {fmtTime(wallMs(s))} from start · {fmtTime(activeMs(s))} active · {mode} mode
              <br />
              {s.hintsUsed.length} hint(s) · {s.pipelineRuns.length} pipeline run(s) · {s.activity.filter((a) => a.kind === 'cmd' || a.kind === 'git').length} commands
            </div>
          </div>
          <ul className="objlist">
            {def.objectives.map((o) => (
              <li key={o.id} style={{ color: s.achieved.includes(o.id) ? 'var(--text)' : 'var(--dim)' }}>
                <span aria-hidden="true">{s.achieved.includes(o.id) ? '✅' : '⬜'} </span>
                <span className="sr">{s.achieved.includes(o.id) ? 'Achieved: ' : 'Not achieved: '}</span>
                {o.title} {o.bonus ? '(bonus)' : ''}
              </li>
            ))}
          </ul>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 12 }}>Skills practised: {def.skills.join(', ')}.</p>
          <div className="actions">
            <button className="btn" onClick={() => downloadReport(def, s, mode)}>
              <span aria-hidden="true">⬇ </span>Download report
            </button>
            <button className="btn" onClick={() => setShowDone(false)}>
              Keep exploring
            </button>
            {nextLab ? (
              <button className="btn primary" data-autofocus onClick={() => go(`/lab/${nextLab.id}`)}>
                Next: {nextLab.title} <span aria-hidden="true">→</span>
              </button>
            ) : (
              <button className="btn primary" data-autofocus onClick={() => go('/labs')}>
                Back to labs
              </button>
            )}
          </div>
        </Modal>
      )}

      <div className="toast" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={t.ok ? 'ok' : ''}>
            {t.ok && <span aria-hidden="true">✔ </span>}
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function GitPanel({ s, onOpen }: { s: LabState; onOpen: (p: string) => void }) {
  const st = status(s);
  const log = ancestry(s.commits, s.head);
  return (
    <div className="findings">
      <div className="scanhdr">
        <b>Branch main</b>
        <span className="chip">{s.remote.url ? `origin: ${s.remote.url}` : 'no remote configured'}</span>
        <span className={s.remote.head === s.head ? 'fresh' : 'stale'}>
          <span aria-hidden="true">● </span>
          {s.remote.head === s.head ? 'in sync with origin/main' : 'local commits not pushed'}
        </span>
      </div>
      {st.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>Working tree clean.</p>
      ) : (
        <ul className="gitlist">
          {st.map((e) => (
            <li key={e.path}>
              {s.files[e.path] !== undefined ? (
                <button type="button" className="gitrow" onClick={() => onOpen(e.path)} title={`Open ${e.path}`}>
                  <GitRowText e={e} />
                </button>
              ) : (
                <span className="gitrow">
                  <GitRowText e={e} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="scanhdr" style={{ marginTop: 16 }}>
        <b>History</b>
      </div>
      {log.map((c) => (
        <div key={c.id} style={{ fontFamily: 'var(--mono)', fontSize: 12.5, padding: '2px 0' }}>
          <Ansi text={`\x1b[33m${c.id.slice(0, 7)}\x1b[0m ${c.id === s.remote.head ? '\x1b[36m(origin/main) \x1b[0m' : ''}${c.message} \x1b[90m— ${c.author.split(' <')[0]}, ${new Date(c.date).toLocaleDateString()}\x1b[0m`} />
        </div>
      ))}
    </div>
  );
}

function GitRowText({ e }: { e: ReturnType<typeof status>[number] }) {
  return (
    <>
      <span style={{ color: e.staged ? 'var(--ok)' : 'var(--high)', display: 'inline-block', width: 90 }}>{e.untracked ? 'untracked' : e.staged ? `staged ${e.staged}` : `modified`}</span>
      {e.path}
    </>
  );
}

function CommitDialog({ s, onClose, onCommit }: { s: LabState; onClose: () => void; onCommit: (msg: string, push: boolean) => void }) {
  const [msg, setMsg] = useState('');
  const [push, setPush] = useState(true);
  const st = status(s);
  return (
    <Modal title="Commit & Push" onClose={onClose} describedBy="commit-desc">
      <p id="commit-desc" style={{ color: 'var(--muted)', fontSize: 13.5, margin: '4px 0' }}>
        Runs <code>git add -A</code>, <code>git commit</code> and optionally <code>git push</code> in the terminal so you can see exactly what happens. Files listed in .gitignore are not added.
      </p>
      <div className="changes" aria-label="Changes to commit" role="group">
        {st.length ? st.map((e) => <div key={e.path}>{e.untracked ? 'A' : e.unstaged ?? e.staged} {e.path}</div>) : <div style={{ color: 'var(--dim)' }}>No changes — nothing to commit.</div>}
      </div>
      <label className="sr" htmlFor="commit-msg">
        Commit message
      </label>
      <input
        id="commit-msg"
        type="text"
        placeholder="Commit message, e.g. Fix SQL injection in orders route"
        value={msg}
        data-autofocus
        onChange={(e) => setMsg(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && msg.trim() && onCommit(msg.trim(), push)}
      />
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, fontSize: 13.5 }}>
        <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> Push to origin/main (triggers the CI pipeline)
      </label>
      <div className="actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!msg.trim()} onClick={() => onCommit(msg.trim(), push)}>
          Commit{push ? ' & Push' : ''}
        </button>
      </div>
    </Modal>
  );
}

function downloadReport(def: LabDef, s: LabState, mode: Mode) {
  const sc = score(def, s, mode);
  const strip = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');
  const md = [
    `# Lab report — ${def.title}`,
    '',
    `- Mode: ${mode}`,
    `- Score: ${sc.score} / ${sc.max}`,
    `- Time: ${fmtTime(wallMs(s))} from start to finish (active: ${fmtTime(activeMs(s))}, time away excluded)`,
    `- Hints used: ${s.hintsUsed.length}`,
    `- Pipeline runs: ${s.pipelineRuns.map((r) => `#${r.id} ${r.status}`).join(', ') || 'none'}`,
    '',
    '## Objectives',
    ...def.objectives.map((o) => `- [${s.achieved.includes(o.id) ? 'x' : ' '}] ${o.title}${o.bonus ? ' (bonus)' : ''}`),
    '',
    '## Latest scan results',
    ...Object.values(s.scans).map((r) => `- ${r!.tool} on ${r!.target}: ${r!.findings.length} finding(s)`),
    '',
    '## Activity log',
    ...s.activity.map((a) => `- ${new Date(a.t).toLocaleTimeString()} ${strip(a.text)}`),
    '',
  ].join('\n');
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${def.id}-report.md`;
  a.click();
  URL.revokeObjectURL(url);
}
