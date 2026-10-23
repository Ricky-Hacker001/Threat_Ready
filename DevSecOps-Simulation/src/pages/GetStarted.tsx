import { useState } from 'react';
import type { Mode } from '../engine/lab';
import type { Progress } from '../store';
import { Brand } from '../components/Brand';

const MODES: { id: Mode; label: string; who: string; chip: string; points: string[] }[] = [
  {
    id: 'guided',
    label: 'Guided',
    who: 'Fresher / career switcher',
    chip: 'green',
    points: ['Step-by-step guidance for every objective', 'One-click example commands', 'Free, progressive hints', 'Key concepts explained in context', 'Levels unlock in order'],
  },
  {
    id: 'standard',
    label: 'Standard',
    who: 'Developer / junior engineer',
    chip: 'blue',
    points: ['Objectives and story, no walkthrough', 'Hints available (−5 points each)', 'You choose commands and fixes', 'Levels unlock in order'],
  },
  {
    id: 'expert',
    label: 'Expert',
    who: 'Experienced DevSecOps / security engineer',
    chip: 'violet',
    points: ['Only the ticket and acceptance criteria', 'No hints, timer with speed bonus', 'Troubleshooting traps left in place', 'All labs unlocked from the start'],
  },
];

export function GetStarted({ progress, update, go }: { progress: Progress; update: (fn: (p: Progress) => Progress) => void; go: (r: string) => void }) {
  const [mode, setMode] = useState<Mode>(progress.mode ?? 'guided');
  return (
    <div className="page">
      <header className="topnav">
        <Brand onClick={() => go('/')} />
        <button className="btn ghost" onClick={() => go('/')}>
          <span aria-hidden="true">←</span> Back
        </button>
      </header>
      <main className="wrap section">
        <span className="chip">Before you start</span>
        <h1 className="pagetitle">How do you want to work?</h1>
        <p className="sub">
          You are joining AeroShop&apos;s platform team. Every lab gives you a repository, a terminal, a CI pipeline and a staging cluster. Choose the level of support
          that fits you — you can change it later from the lab dashboard (a lab you have already started keeps its mode).
        </p>
        <div className="modes" role="group" aria-label="Support level">
          {MODES.map((m) => {
            const on = mode === m.id;
            return (
              // The whole card is clickable for mouse users; the button inside is the keyboard and screen-reader control.
              <div key={m.id} className={`mode ${on ? 'on' : ''}`} onClick={() => setMode(m.id)}>
                <span className={`chip ${m.chip}`}>{m.label}</span>
                <h2 id={`mode-${m.id}`}>{m.label} mode</h2>
                <div className="who">{m.who}</div>
                <ul id={`mode-${m.id}-points`}>
                  {m.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  className={`btn sm ${on ? 'primary' : ''}`}
                  aria-pressed={on}
                  aria-describedby={`mode-${m.id}-points`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMode(m.id);
                  }}
                >
                  {on ? <><span aria-hidden="true">✓ </span>Selected: {m.label}</> : `Choose ${m.label}`}
                </button>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 28, display: 'flex', gap: 12 }}>
          <button
            className="btn primary"
            onClick={() => {
              update((p) => ({ ...p, mode }));
              go('/labs');
            }}
          >
            Continue to my labs <span aria-hidden="true">→</span>
          </button>
        </div>
      </main>
    </div>
  );
}
