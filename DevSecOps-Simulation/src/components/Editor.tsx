import { useEffect, useId, useRef, useState } from 'react';
import type { Finding } from '../engine/types';

const SEV_COLOR: Record<string, string> = { CRITICAL: 'var(--crit)', HIGH: 'var(--high)', MEDIUM: 'var(--med)', LOW: 'var(--low)', INFO: 'var(--dim)' };

interface Props {
  path: string | null;
  value: string;
  onChange: (v: string) => void;
  findings: Finding[];
  status: string | null;
  jumpTo: { line: number; n: number } | null;
  /** Every file in the repository, for the file picker shown when the explorer is hidden (≤720 px). */
  files: string[];
  onOpen: (p: string) => void;
  onNew: () => void;
  onDelete: (p: string) => void;
}

/**
 * Lightweight code editor: textarea with line numbers and finding markers in the gutter.
 * Keyboard: Tab indents (no modifier keys held); Shift+Tab, or Esc then Tab, moves focus out of the editor.
 */
export function Editor({ path, value, onChange, findings, status, jumpTo, files, onOpen, onNew, onDelete }: Props) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const escaped = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const hintId = useId();
  const lines = value.split('\n');
  // The textarea is as wide as the longest line, so the editor body scrolls sideways instead of clipping code.
  const longest = lines.reduce((n, l) => Math.max(n, l.replace(/\t/g, '  ').length), 0);

  useEffect(() => {
    if (!jumpTo || !ta.current || !body.current) return;
    const idx = lines.slice(0, jumpTo.line - 1).join('\n').length + (jumpTo.line > 1 ? 1 : 0);
    ta.current.focus();
    ta.current.setSelectionRange(idx, idx + (lines[jumpTo.line - 1]?.length ?? 0));
    body.current.scrollTop = Math.max(0, (jumpTo.line - 6) * 20);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo]);

  const picker = (
    <div className="filepick">
      <label>
        <span>File</span>
        <select value={path ?? ''} onChange={(e) => e.target.value && onOpen(e.target.value)}>
          {!path && <option value="">Choose a file…</option>}
          {[...files].sort().map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn sm ghost" onClick={onNew}>
        <span aria-hidden="true">＋ </span>New file
      </button>
    </div>
  );

  if (!path)
    return (
      <div className="editor">
        <div className="edhead">No file open</div>
        {picker}
        <div className="empty">Select a file in the explorer</div>
      </div>
    );

  const marks = new Map<number, Finding>();
  for (const f of findings) if (f.file === path && f.line && !marks.has(f.line)) marks.set(f.line, f);

  return (
    <div className="editor">
      <div className="edhead">
        <span style={{ color: 'var(--text)' }}>{path}</span>
        {status && <span className="chip amber" style={{ fontFamily: 'var(--sans)' }}>{status}</span>}
        <span className="spacer" />
        <span className="edhint" id={hintId}>
          {leaving ? 'Tab now leaves the editor' : 'Tab indents · Esc then Tab leaves'}
        </span>
        <span className="edmeta">{lines.length} lines · auto-saved</span>
        <button type="button" className="btn sm ghost" title={`Delete ${path}`} onClick={() => window.confirm(`Delete ${path}?`) && onDelete(path)}>
          Delete file
        </button>
      </div>
      {picker}
      <div className="edbody" ref={body}>
        <div className="gutter" aria-hidden="true">
          {lines.map((_, i) => {
            const f = marks.get(i + 1);
            return (
              <div key={i} className={f ? 'flag' : ''} title={f ? `${f.severity} ${f.ruleId}: ${f.title}` : undefined} style={f ? ({ '--sevc': SEV_COLOR[f.severity] } as React.CSSProperties) : undefined}>
                {i + 1}
              </div>
            );
          })}
        </div>
        <textarea
          ref={ta}
          spellCheck={false}
          value={value}
          rows={lines.length + 2}
          wrap="off"
          aria-label={`Code editor: ${path}`}
          aria-describedby={hintId}
          style={{ width: `max(100%, calc(${longest + 2}ch + 24px))` }}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            escaped.current = false;
            setLeaving(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              escaped.current = true;
              setLeaving(true);
              return;
            }
            if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !escaped.current) {
              e.preventDefault();
              const t = e.currentTarget;
              const { selectionStart: a, selectionEnd: b } = t;
              const next = value.slice(0, a) + '  ' + value.slice(b);
              onChange(next);
              requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
              return;
            }
            if (e.key !== 'Tab' && e.key !== 'Shift') {
              escaped.current = false;
              setLeaving(false);
            }
          }}
        />
      </div>
    </div>
  );
}
