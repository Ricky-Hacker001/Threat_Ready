import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { clock, ErrorNote } from './bits.jsx';

const PHASES = ['Containment', 'Evidence', 'Eradication', 'Recovery', 'Communication'];

export default function ResponsePanel({ cs, onCase }) {
  const r = cs.current.response;
  const [type, setType] = useState('isolate_host');
  const [target, setTarget] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [finishing, setFinishing] = useState(false);
  // Confirmation prompts take focus so they are not missed by keyboard and screen-reader users.
  const confirmRef = useRef(null);
  const finishRef = useRef(null);
  useEffect(() => { if (confirm) confirmRef.current?.focus(); }, [confirm]);
  useEffect(() => { if (finishing) finishRef.current?.focus(); }, [finishing]);
  const def = r.catalog.find((a) => a.type === type);

  const exec = async (confirmed) => {
    setBusy(true);
    setErr(null);
    try {
      const out = await api.action(cs.id, { type, target, comment, confirm: confirmed });
      setConfirm(null);
      setTarget('');
      setComment('');
      onCase(out.case);
    } catch (e) {
      if (e.body?.needsConfirmation) setConfirm(e.body.message);
      else setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    try { onCase((await api.submit(cs.id, {})).case); } catch (e) { setErr(e); setBusy(false); }
  };

  const iocs = cs.iocs.map((i) => i.value);
  let targetInput;
  if (def.target === 'host') {
    targetInput = (
      <select className="input" value={target} onChange={(e) => { setTarget(e.target.value); setConfirm(null); }} aria-label="Target host">
        <option value="">Select host…</option>
        {cs.directory.hosts.map((h) => <option key={h.name} value={h.name}>{h.name} - {h.role}</option>)}
      </select>
    );
  } else if (def.target === 'account') {
    targetInput = (
      <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target account">
        <option value="">Select account…</option>
        {cs.directory.accounts.map((a) => <option key={a.sam} value={a.sam}>{a.sam} - {a.name}</option>)}
      </select>
    );
  } else if (def.target === 'stakeholder') {
    targetInput = (
      <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Stakeholder">
        <option value="">Select stakeholder…</option>
        {r.stakeholders.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
    );
  } else {
    targetInput = (
      <>
        <input className="input mono" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={def.placeholder} list="dl-iocs" aria-label="Target" spellCheck={false} />
        <datalist id="dl-iocs">{iocs.map((v) => <option key={v} value={v} />)}</datalist>
      </>
    );
  }

  const done = [...r.actions].reverse();
  return (
    <div className="response">
      <form className="composer" data-tour="composer" onSubmit={(e) => { e.preventDefault(); exec(false); }}>
        <label className="fld-label" htmlFor="act-type">Action</label>
        <select id="act-type" className="input" value={type} onChange={(e) => { setType(e.target.value); setTarget(''); setConfirm(null); setErr(null); }}>
          {PHASES.map((p) => (
            <optgroup key={p} label={p}>
              {r.catalog.filter((a) => a.phase === p).map((a) => <option key={a.type} value={a.type}>{a.label}</option>)}
            </optgroup>
          ))}
        </select>
        <p className="fld-help">{def.desc}</p>
        <span className="fld-label" aria-hidden="true">Target</span>
        {targetInput}
        <label className="fld-label" htmlFor="act-comment">Justification <span className="muted">(optional, recorded in the case file)</span></label>
        <input id="act-comment" className="input" value={comment} onChange={(e) => setComment(e.target.value)} />
        <ErrorNote error={err} onDismiss={() => setErr(null)} />
        {confirm ? (
          <div className="note note-warn" role="alertdialog" aria-label="Confirm action" aria-describedby="act-confirm-text" tabIndex={-1} ref={confirmRef}>
            <p id="act-confirm-text">{confirm}</p>
            <div className="stage-actions">
              <button type="button" className="btn btn-danger" onClick={() => exec(true)} disabled={busy}>{busy ? 'Executing…' : `Confirm: ${def.label.toLowerCase()} ${target}`}</button>
              <button type="button" className="link" onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={busy || !target}>{busy ? 'Executing…' : 'Execute action'}</button>
        )}
      </form>

      <section className="board" data-tour="env-state">
        <h3>Environment state</h3>
        {!r.hosts.length && !r.blocks.length && !r.accounts.length && !r.notified.length && <p className="muted">No response actions have changed anything yet.</p>}
        {r.hosts.length > 0 && (
          <dl className="state">
            {r.hosts.map((h) => <div key={h.host}><dt>{h.host}</dt><dd>{h.status.map((s) => <span key={s} className={`state-tag${s === 'Isolated' ? ' is-warn' : ''}`}>{s}</span>)}</dd></div>)}
          </dl>
        )}
        {r.accounts.length > 0 && <dl className="state">{r.accounts.map((a) => <div key={a.account + a.status}><dt>{a.account}</dt><dd><span className="state-tag">{a.status}</span></dd></div>)}</dl>}
        {r.blocks.length > 0 && <dl className="state">{r.blocks.map((b) => <div key={b.kind + b.value}><dt>{b.kind} blocked</dt><dd className="mono break">{b.value}</dd></div>)}</dl>}
        {r.notified.length > 0 && <dl className="state"><div><dt>Notified</dt><dd>{r.notified.join(', ')}</dd></div></dl>}
      </section>

      <section className="board" data-tour="action-log">
        <h3>Action log <span className="muted">{done.length}</span></h3>
        {!done.length && <p className="muted">Executed actions appear here and in the live feed as audit events.</p>}
        <ol className="actions">
          {done.map((a) => (
            <li key={a.id} className={a.ok ? '' : 'is-noop'}>
              <p className="act-head"><span className="mono">{clock(a.ts)}</span> <strong>{a.label}</strong> <span className="break">{a.targetLabel}</span>{!a.ok && <span className="state-tag">No change</span>}</p>
              <p>{a.summary}</p>
              {a.details?.length > 0 && <ul className="notes mono break">{a.details.map((d) => <li key={d}>{d}</li>)}</ul>}
              {a.impact && <p className="impact">Business impact: {a.impact}</p>}
              {a.comment && <p className="muted">Justification: {a.comment}</p>}
            </li>
          ))}
        </ol>
      </section>

      <div className="stage-actions" data-tour="declare">
        {!finishing ? (
          <button type="button" className="btn" onClick={() => setFinishing(true)}>Declare response complete</button>
        ) : (
          <span className="confirm" role="group" aria-label="Confirm response complete">
            Response actions lock after this and the ticket moves to closure.
            <button type="button" className="btn btn-primary btn-sm" ref={finishRef} onClick={finish} disabled={busy}>{busy ? 'Submitting…' : 'Confirm, response is complete'}</button>
            <button type="button" className="link" onClick={() => setFinishing(false)}>Keep responding</button>
          </span>
        )}
      </div>
    </div>
  );
}
