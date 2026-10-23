import { useState, type ReactNode } from 'react';
import type { LabDef, Mode } from '../engine/lab';
import type { LabState } from '../engine/types';

/** Tiny formatter for `code` and **bold** in guidance text. */
export function Rich({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('`') ? <code key={m.index}>{t.slice(1, -1)}</code> : <b key={m.index}>{t.slice(2, -2)}</b>);
    last = m.index + t.length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

interface Props {
  def: LabDef;
  s: LabState;
  mode: Mode;
  onRun: (cmd: string) => void;
  onPaste: (cmd: string) => void;
  onHint: (key: string) => void;
  /** The dashboard mode, when it differs from the mode this attempt was started in. */
  dashboardMode?: Mode | null;
}

const MODE_NAME: Record<Mode, string> = { guided: 'Guided', standard: 'Standard', expert: 'Expert' };

export function TaskPanel({ def, s, mode, onRun, onPaste, onHint, dashboardMode }: Props) {
  const nextId = def.objectives.find((o) => !o.bonus && !s.achieved.includes(o.id))?.id;
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const req = def.objectives.filter((o) => !o.bonus);
  const done = req.filter((o) => s.achieved.includes(o.id)).length;

  return (
    <aside className="task" aria-label="Lab briefing and objectives">
      {dashboardMode && dashboardMode !== mode && !s.completedAt && (
        <div className="block modenote" role="note">
          This attempt runs in <b>{MODE_NAME[mode]}</b> mode, the mode it was started in, so hints and scoring stay the same. To use <b>{MODE_NAME[dashboardMode]}</b> mode,
          reset the lab (↺ Reset) — that starts a fresh attempt.
        </div>
      )}
      <div className="block">
        <h2 className="blockh">{mode === 'expert' ? 'Ticket' : 'Mission briefing'}</h2>
        {mode !== 'expert' && <p>{def.story}</p>}
        <div className="ticket">{def.ticket}</div>
      </div>

      <div className="block">
        <h2 className="blockh">
          {mode === 'expert' ? 'Acceptance criteria' : 'Objectives'} · {done}/{req.length}
        </h2>
        <div className="progressbar" style={{ marginBottom: 12 }}>
          <i style={{ width: `${(done / req.length) * 100}%` }} />
        </div>
        {def.objectives.map((o) => {
          const isDone = s.achieved.includes(o.id);
          const isNext = o.id === nextId;
          const open = openIds[o.id] ?? (mode === 'guided' && isNext);
          const shownHints = o.hints.filter((_, i) => s.hintsUsed.includes(`${o.id}:${i}`));
          const canExpand = mode !== 'expert';
          return (
            <div key={o.id} className={`obj ${isDone ? 'done' : ''} ${isNext ? 'next' : ''}`}>
              {canExpand ? (
                <button type="button" className="head" aria-expanded={!!open} onClick={() => setOpenIds((x) => ({ ...x, [o.id]: !open }))}>
                  <span className="tick" aria-hidden="true">
                    {isDone ? '✓' : ''}
                  </span>
                  <span className="t">
                    <span className="sr">{isDone ? 'Done: ' : isNext ? 'Next: ' : 'To do: '}</span>
                    {o.title} {o.bonus && <span className="chip amber" style={{ marginLeft: 4 }}>bonus</span>}
                  </span>
                </button>
              ) : (
                <div className="head">
                  <span className="tick" aria-hidden="true">
                    {isDone ? '✓' : ''}
                  </span>
                  <span className="t">
                    <span className="sr">{isDone ? 'Done: ' : 'To do: '}</span>
                    {o.title} {o.bonus && <span className="chip amber" style={{ marginLeft: 4 }}>bonus</span>}
                  </span>
                </div>
              )}
              {canExpand && open && (
                <div className="body">
                  {mode === 'guided' && (
                    <p>
                      <Rich text={o.guide} />
                    </p>
                  )}
                  {mode === 'guided' && o.command && (
                    <div className="cmd">
                      <code>{o.command}</code>
                      <button className="btn sm" title="Put the command in the terminal so you can edit it" onClick={() => onPaste(o.command!)}>
                        Paste
                      </button>
                      <button className="btn sm primary" onClick={() => onRun(o.command!)}>
                        Run <span aria-hidden="true">▸</span>
                      </button>
                    </div>
                  )}
                  {shownHints.map((h, i) => (
                    <div className="hint" key={i}>
                      <span aria-hidden="true">💡 </span>
                      <span className="sr">Hint: </span>
                      <Rich text={h} />
                    </div>
                  ))}
                  {shownHints.length < o.hints.length && !isDone && (
                    <button className="btn sm ghost" onClick={() => onHint(`${o.id}:${shownHints.length}`)}>
                      {mode === 'guided' ? 'Show a hint' : 'Get a hint (−5 points)'}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {mode === 'expert' && <p style={{ color: 'var(--dim)', fontSize: 12.5, marginTop: 10 }}>Expert mode: no guidance or hints. Criteria are checked automatically against the repository, pipeline and environment state.</p>}
      </div>

      {mode !== 'expert' && (
        <div className="block">
          <h2 className="blockh">Key concepts</h2>
          {def.concepts.map((c) => (
            <div className="concept" key={c.term}>
              <b>{c.term}</b>
              <div>{c.text}</div>
            </div>
          ))}
        </div>
      )}

      <div className="block">
        <h2 className="blockh">Tools in this lab</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {def.tools.map((t) => (
            <span className="chip" key={t} style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>
              {t}
            </span>
          ))}
        </div>
        <p style={{ marginTop: 10, color: 'var(--muted)', fontSize: 12.5 }}>
          Type <code>help</code> in the terminal for every supported command.
        </p>
      </div>
    </aside>
  );
}
