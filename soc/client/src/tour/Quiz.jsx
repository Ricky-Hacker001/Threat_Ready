// Interactive content inside a guided step: a real log event to read, two
// patterns to compare, and questions. The questions and options come from
// the server; so does every verdict. Nothing here knows a correct answer.

import React, { useState } from 'react';

function EventCard({ ev, title }) {
  return (
    <div className="gq-event">
      {title && <p className="gq-cap">{title}</p>}
      <div className="raw-line">{ev.raw}</div>
      <dl className="gq-fields">
        {Object.entries(ev.fields).filter(([k]) => k !== 'source').map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>
        ))}
      </dl>
    </div>
  );
}

function Example({ ex }) {
  return (
    <div className="gq-example">
      <p className="gq-cap">{ex.title}</p>
      <div className="raw-line">{ex.raw}</div>
      <div className="table-wrap">
        <table className="grid gq-table">
          <thead><tr><th>Field</th><th>Value</th><th>What it means</th><th>Why it matters</th><th>How to verify it</th></tr></thead>
          <tbody>
            {ex.rows.map((r) => (
              <tr key={r.field}><td className="mono">{r.field}</td><td className="mono break">{r.value}</td><td>{r.meaning}</td><td>{r.matters}</td><td>{r.verify}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Question({ q, value, onChange, item, disabled }) {
  const name = `gq-${q.id}`;
  let control;
  if (q.kind === 'text') {
    control = <input className="input mono" value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={q.placeholder} aria-label={q.prompt} spellCheck={false} disabled={disabled} />;
  } else if (q.kind === 'multi') {
    const v = value || [];
    control = (
      <div className="options">
        {q.options.map((o) => (
          <label key={o.value} className={`option${v.includes(o.value) ? ' is-on' : ''}`}>
            <input type="checkbox" checked={v.includes(o.value)} disabled={disabled} onChange={() => onChange(v.includes(o.value) ? v.filter((x) => x !== o.value) : [...v, o.value])} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    );
  } else if (q.options.length > 6) {
    control = (
      <select className="input" value={value || ''} onChange={(e) => onChange(e.target.value)} aria-label={q.prompt} disabled={disabled}>
        <option value="">Select a field…</option>
        {q.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else {
    control = (
      <div className="options">
        {q.options.map((o) => (
          <label key={o.value} className={`option${value === o.value ? ' is-on' : ''}`}>
            <input type="radio" name={name} checked={value === o.value} disabled={disabled} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    );
  }
  return (
    <fieldset className={`gq-q${item ? (item.ok ? ' is-ok' : ' is-bad') : ''}`} data-q={q.id}>
      <legend>{q.prompt}</legend>
      {control}
      {item && <p className="gq-note"><span className="gt-mark" aria-hidden="true">{item.ok ? '✓' : '✗'}</span><span><strong>{item.ok ? 'Accepted. ' : 'Not accepted. '}</strong>{item.message}</span></p>}
    </fieldset>
  );
}

export default function Quiz({ widget, answers, onChange, items, disabled }) {
  const [mode, setMode] = useState(widget.modes ? null : 'try');
  const byId = Object.fromEntries((items || []).map((i) => [i.id, i]));
  return (
    <div className="gq">
      {widget.panels && (
        <div className="gq-panels">
          {widget.panels.map((p) => (
            <section key={p.title} className="gq-panel">
              <h4>{p.title}</h4>
              <dl className="gq-facts">{p.facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
              {p.note && <p className="gq-cap">{p.note}</p>}
              {p.events.map((e) => <div className="raw-line" key={e.id}>{e.raw}</div>)}
            </section>
          ))}
        </div>
      )}
      {widget.modes && (
        <div className="gq-modes" role="group" aria-label="How do you want to do this step">
          <button type="button" className={`btn btn-sm${mode === 'example' ? ' btn-on' : ''}`} aria-pressed={mode === 'example'} onClick={() => setMode('example')}>Show me an example</button>
          <button type="button" className={`btn btn-sm${mode === 'try' ? ' btn-on' : ''}`} aria-pressed={mode === 'try'} onClick={() => setMode('try')}>Try it myself</button>
        </div>
      )}
      {mode === 'example' && widget.example && (
        <>
          <Example ex={widget.example} />
          <p className="gq-cap">The example is a different log line. When you are ready, choose "Try it myself".</p>
        </>
      )}
      {mode === 'try' && (
        <>
          {widget.event && <EventCard ev={widget.event} title={widget.eventTitle} />}
          {widget.questions.map((q) => (
            <Question key={q.id} q={q} value={answers[q.id]} item={byId[q.id]} disabled={disabled} onChange={(v) => onChange({ ...answers, [q.id]: v })} />
          ))}
        </>
      )}
    </div>
  );
}
