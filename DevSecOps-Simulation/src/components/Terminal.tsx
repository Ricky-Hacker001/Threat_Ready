import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { Ansi } from './Ansi';
import { COMMANDS } from '../engine/shell';

export interface TerminalHandle {
  run: (cmd: string) => void;
  insert: (cmd: string) => void;
  print: (lines: string[]) => void;
}

interface Props {
  execute: (cmd: string) => { out: string[]; code: number };
  files: string[];
  initial: string[];
}

const PROMPT = 'devsecops@aeroshop:~/aeroshop-api$';
const stripAnsi = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');

/** What screen readers hear after a command: its own output only (not the whole buffer), capped. */
function announce(cmd: string, out: string[], code: number): string {
  const text = out
    .map(stripAnsi)
    .filter((l) => l.trim())
    .join('\n');
  const capped = text.length > 600 ? `${text.slice(0, 600)}… (output continues in the terminal)` : text;
  return `${cmd}: ${capped || 'no output'}${code ? ` (exit ${code})` : ''}`;
}

export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal({ execute, files, initial }, ref) {
  const [lines, setLines] = useState<string[]>(initial);
  const [input, setInput] = useState('');
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  const escaped = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const [live, setLive] = useState('');
  const hintId = useId();

  const run = (cmd: string) => {
    const c = cmd.trim();
    const echo = `\x1b[32m${PROMPT}\x1b[0m ${cmd}`;
    if (!c) {
      setLines((l) => [...l, echo]);
      return;
    }
    setHist((h) => [...h.filter((x) => x !== c), c]);
    setHi(-1);
    const r = execute(c);
    if (r.out.includes('\x1bc')) {
      setLines([]);
      setLive('Terminal cleared');
      return;
    }
    setLines((l) => [...l, echo, ...r.out, ...(r.code ? [`\x1b[90m[exit ${r.code}]\x1b[0m`] : [])].slice(-2000));
    setLive(announce(c, r.out, r.code));
  };

  useImperativeHandle(ref, () => ({
    run: (cmd) => {
      run(cmd);
      inp.current?.focus();
    },
    insert: (cmd) => {
      setInput(cmd);
      inp.current?.focus();
    },
    print: (ls) => setLines((l) => [...l, ...ls]),
  }));

  useEffect(() => {
    box.current?.scrollTo(0, box.current.scrollHeight);
  }, [lines]);

  const complete = () => {
    const parts = input.split(' ');
    const last = parts[parts.length - 1];
    const pool = parts.length === 1 ? COMMANDS : [...files, ...new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/') + '/')))];
    const hits = pool.filter((x) => x.startsWith(last));
    if (hits.length === 1) setInput([...parts.slice(0, -1), hits[0]].join(' '));
    else if (hits.length > 1) {
      let pre = hits[0];
      for (const h of hits) while (!h.startsWith(pre)) pre = pre.slice(0, -1);
      if (pre.length > last.length) setInput([...parts.slice(0, -1), pre].join(' '));
      else setLines((l) => [...l, `\x1b[32m${PROMPT}\x1b[0m ${input}`, hits.slice(0, 40).join('   ')]);
    }
  };

  return (
    <div className="term" ref={box} onClick={() => window.getSelection()?.isCollapsed && inp.current?.focus()}>
      {lines.map((l, i) => (
        <div className="ln" key={i}>
          <Ansi text={l} />
        </div>
      ))}
      <div className="inrow">
        <span className="prompt" aria-hidden="true">
          {PROMPT}
        </span>
        <input
          ref={inp}
          value={input}
          spellCheck={false}
          autoComplete="off"
          aria-label="Terminal command"
          aria-describedby={hintId}
          onChange={(e) => setInput(e.target.value)}
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
            if (e.key === 'Tab') {
              // Tab completes; Shift+Tab, a modifier key, or Esc then Tab moves focus out (no keyboard trap).
              if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || escaped.current) return;
              e.preventDefault();
              complete();
              return;
            }
            if (e.key !== 'Shift') {
              escaped.current = false;
              setLeaving(false);
            }
            if (e.key === 'Enter') {
              run(input);
              setInput('');
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              const n = hi < 0 ? hist.length - 1 : Math.max(0, hi - 1);
              if (hist[n] !== undefined) {
                setHi(n);
                setInput(hist[n]);
              }
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              const n = hi + 1;
              if (hi >= 0 && n < hist.length) {
                setHi(n);
                setInput(hist[n]);
              } else {
                setHi(-1);
                setInput('');
              }
            } else if (e.key === 'l' && e.ctrlKey) {
              e.preventDefault();
              setLines([]);
            }
          }}
        />
      </div>
      <div className="termhint" id={hintId}>
        {leaving ? 'Tab now leaves the terminal' : 'Tab completes · ↑/↓ history · Esc then Tab leaves the terminal'}
      </div>
      <div className="sr" role="status" aria-live="polite">
        {live}
      </div>
    </div>
  );
});
