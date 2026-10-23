import type { Mode } from '../engine/lab';
import { LABS, LEVELS } from '../content/labs';
import { loadLabState, resetAll, type Progress } from '../store';
import { Brand } from '../components/Brand';

const MODE_LABEL: Record<Mode, string> = { guided: 'Guided', standard: 'Standard', expert: 'Expert' };

export function isUnlocked(id: string, progress: Progress): boolean {
  if (progress.mode === 'expert') return true;
  const idx = LABS.findIndex((l) => l.id === id);
  return idx <= 0 || !!progress.results[LABS[idx - 1].id];
}

/** A lab started in Expert mode (which unlocks everything) stays open after a later switch to another mode. */
export function canOpen(id: string, progress: Progress): boolean {
  return isUnlocked(id, progress) || loadLabState(id)?.mode === 'expert';
}

export function Dashboard({ progress, update, go }: { progress: Progress; update: (fn: (p: Progress) => Progress) => void; go: (r: string) => void }) {
  const done = LABS.filter((l) => progress.results[l.id]).length;
  const points = Object.values(progress.results).reduce((n, r) => n + r.score, 0);
  const nextLab = LABS.find((l) => !progress.results[l.id] && isUnlocked(l.id, progress));
  const inProgress = LABS.some((l) => !progress.results[l.id] && loadLabState(l.id));
  return (
    <div className="page">
      <header className="topnav">
        <Brand onClick={() => go('/')} />
        <div className="navacts">
          <span id="mode-label" style={{ color: 'var(--muted)', fontSize: 13 }}>
            Mode
          </span>
          <div className="segmented" role="group" aria-labelledby="mode-label" aria-describedby={inProgress ? 'mode-note' : undefined}>
            {(['guided', 'standard', 'expert'] as Mode[]).map((m) => (
              <button key={m} className={progress.mode === m ? 'on' : ''} aria-pressed={progress.mode === m} onClick={() => update((p) => ({ ...p, mode: m }))}>
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </div>
      </header>
      <main className="wrap">
        {inProgress && (
          <p id="mode-note" className="modenote">
            A mode change applies to labs you start or reset next. Labs already in progress keep the mode they were started in, so hints and scoring stay
            consistent.
          </p>
        )}
        <div className="dashhead">
          <div>
            <h1>My DevSecOps labs</h1>
            <p style={{ color: 'var(--muted)', margin: '6px 0 0' }}>Each lab is a working repository with its own terminal, pipeline and staging environment. Your work is saved in this browser.</p>
          </div>
          <div className="stats">
            <div className="stat">
              <b>
                {done}/{LABS.length}
              </b>
              <span>labs completed</span>
            </div>
            <div className="stat">
              <b>{points}</b>
              <span>points earned</span>
            </div>
            {nextLab && (
              <button className="btn primary" onClick={() => go(`/lab/${nextLab.id}`)}>
                {loadLabState(nextLab.id) ? 'Continue' : 'Start'}: {nextLab.title} <span aria-hidden="true">→</span>
              </button>
            )}
          </div>
        </div>
        <div className="progressbar" style={{ marginTop: 10 }}>
          <i style={{ width: `${(done / LABS.length) * 100}%` }} />
        </div>

        {LEVELS.map((lv) => (
          <div className="levelrow" key={lv.level}>
            <h2>
              <span className="lvl">LEVEL {lv.level}</span> {lv.name} <small>— {lv.blurb}</small>
            </h2>
            <div className="labs">
              {LABS.filter((l) => l.level === lv.level).map((l) => {
                const unlocked = canOpen(l.id, progress);
                const result = progress.results[l.id];
                const saved = loadLabState(l.id);
                const req = l.objectives.filter((o) => !o.bonus);
                const doneN = saved ? req.filter((o) => saved.achieved.includes(o.id)).length : 0;
                return (
                  <div className={`card labcard ${unlocked ? '' : 'locked'}`} key={l.id}>
                    <div className="row">
                      <span className="chip blue">{l.track}</span>
                      {result ? (
                        <span className="chip green">
                          <span aria-hidden="true">✔</span> Completed · {result.score} pts
                        </span>
                      ) : saved ? (
                        <span className="chip amber">In progress{saved.mode ? ` · ${MODE_LABEL[saved.mode]}` : ''}</span>
                      ) : (
                        <span className="chip">~{l.minutes} min</span>
                      )}
                    </div>
                    <h3 id={`lab-${l.id}`}>{l.title}</h3>
                    <p>{l.summary}</p>
                    <div className="meta">
                      {l.tools.slice(0, 5).map((t) => (
                        <span className="chip" key={t} style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                          {t}
                        </span>
                      ))}
                    </div>
                    {saved && !result && (
                      <div className="progressbar">
                        <i style={{ width: `${(doneN / req.length) * 100}%` }} />
                      </div>
                    )}
                    <div className="bottom">
                      <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>
                        {req.length} objectives{l.objectives.some((o) => o.bonus) ? ' + bonus' : ''}
                      </span>
                      <button className={`btn sm ${unlocked && !result ? 'primary' : ''}`} disabled={!unlocked} aria-describedby={`lab-${l.id}`} onClick={() => go(`/lab/${l.id}`)}>
                        {!unlocked ? (
                          <>
                            <span aria-hidden="true">🔒 </span>Locked: complete the previous lab
                          </>
                        ) : result ? (
                          'Review'
                        ) : saved ? (
                          'Resume'
                        ) : (
                          'Start lab'
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div style={{ textAlign: 'right', paddingBottom: 30 }}>
          <button
            className="btn sm danger"
            onClick={() => {
              if (window.confirm('Reset all lab progress stored in this browser?')) {
                resetAll();
                update(() => ({ mode: progress.mode, results: {} }));
              }
            }}
          >
            Reset all progress
          </button>
        </div>
      </main>
    </div>
  );
}
