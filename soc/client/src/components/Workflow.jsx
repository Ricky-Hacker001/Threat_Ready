import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { clock, stamp, SourceTag, Severity, Verdict, ErrorNote, duration } from './bits.jsx';
import ResponsePanel from './ResponsePanel.jsx';
import { bridge } from '../tour/bridge.js';

function PinChoice({ pins, selected, onToggle, single, name, disabled }) {
  if (!pins.length) return <p className="hint-empty">No pinned events yet. Pin log lines from the live feed, search or alert tab, then choose them here.</p>;
  return (
    <ul className="pin-choice">
      {pins.map((p) => (
        <li key={p.eventId}>
          <label>
            <input type={single ? 'radio' : 'checkbox'} name={name} checked={selected.includes(p.eventId)} onChange={() => onToggle(p.eventId)} disabled={disabled} />
            <span className="pin-choice-body">
              <span className="pin-choice-meta"><span className="mono">{clock(p.event.ts)}</span> <SourceTag source={p.event.source} /> {p.event.host}</span>
              <span className="mono pin-choice-raw">{p.event.raw.slice(p.event.raw.indexOf(': ') + 2)}</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function PickMany({ options, value, onChange, placeholder, disabled }) {
  const left = options.filter((o) => !value.includes(o.value));
  return (
    <div className="pickmany">
      <div className="picked">
        {value.map((v) => (
          <span className="token" key={v}>
            {options.find((o) => o.value === v)?.short || v}
            {!disabled && <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>×</button>}
          </span>
        ))}
        {!value.length && <span className="muted">None selected</span>}
      </div>
      {!disabled && (
        <select className="input" value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} aria-label={placeholder}>
          <option value="">{placeholder}</option>
          {left.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </div>
  );
}

// Intermediate: a hint is requested per question and caps its credit.
function HintLink({ f, cs, locked }) {
  const [text, setText] = useState(f.hintText || null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (text) return <p className="fld-hint" role="note"><strong>Hint</strong> (credit for this question is capped at 80%): {text}</p>;
  if (locked || cs.status !== 'open') return null;
  return (
    <p className="fld-hint-ask">
      <button type="button" className="link" disabled={busy} onClick={async () => {
        setBusy(true);
        try { const r = await api.hint(cs.id, cs.current.id, f.id); setText(r.hint); } catch (e) { setErr(e); } finally { setBusy(false); }
      }}>Show hint</button>
      <span className="muted small"> Using it caps this question at 80% credit.</span>
      {err && <span className="small danger"> {err.message}</span>}
    </p>
  );
}

function Field({ f, value, onChange, cs, links, onLinks, fb }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const locked = !!fb?.locked;
  const pins = [...cs.pins].sort((a, b) => a.event.ts - b.event.ts);
  const hostOpts = cs.directory.hosts.map((h) => ({ value: h.name, label: `${h.name} - ${h.role}`, short: h.name }));
  const acctOpts = cs.directory.accounts.map((a) => ({ value: a.sam, label: `${a.sam} - ${a.name}${a.type !== 'user' ? ` (${a.type})` : ''}`, short: a.sam }));
  const id = `f-${f.id}`;
  let control = null;

  switch (f.type) {
    case 'single':
      control = (
        <div className="options" role="radiogroup" aria-labelledby={`${id}-l`}>
          {f.options.map((o) => (
            <label key={o.value} className={`option${value === o.value ? ' is-on' : ''}`}>
              <input type="radio" name={id} checked={value === o.value} onChange={() => onChange(o.value)} disabled={locked} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
      break;
    case 'multi': {
      const v = value || [];
      control = (
        <div className="options" role="group" aria-labelledby={`${id}-l`}>
          {f.options.map((o) => (
            <label key={o.value} className={`option${v.includes(o.value) ? ' is-on' : ''}`}>
              <input type="checkbox" checked={v.includes(o.value)} onChange={() => onChange(v.includes(o.value) ? v.filter((x) => x !== o.value) : [...v, o.value])} disabled={locked} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
      break;
    }
    case 'host': case 'account': {
      const opts = f.type === 'host' ? hostOpts : acctOpts;
      control = (
        <select className="input" id={id} value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={locked}>
          <option value="">Select…</option>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    }
    case 'hosts': case 'accounts':
      control = <PickMany options={f.type === 'hosts' ? hostOpts : acctOpts} value={value || []} onChange={onChange} placeholder={f.type === 'hosts' ? 'Add a host…' : 'Add an account…'} disabled={locked} />;
      break;
    case 'text':
      control = <input className="input mono" id={id} value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={f.placeholder} spellCheck={false} disabled={locked} />;
      break;
    case 'longtext': {
      const n = (value || '').trim().length;
      control = (
        <>
          <textarea className="input" id={id} rows={4} value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={locked} />
          {f.min && <span className={`counter${n >= f.min ? ' ok' : ''}`}>{n} / {f.min} characters minimum</span>}
        </>
      );
      break;
    }
    case 'order': {
      const order = value && value.length === f.items.length ? value : f.items.map((i) => i.id);
      const move = (i, d) => {
        const n = [...order];
        [n[i], n[i + d]] = [n[i + d], n[i]];
        onChange(n);
      };
      control = (
        <ol className="order">
          {order.map((oid, i) => (
            <li key={oid}>
              <span className="order-n">{i + 1}</span>
              <span className="grow">{f.items.find((x) => x.id === oid)?.label}</span>
              <button type="button" className="btn btn-xs" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move earlier">↑</button>
              <button type="button" className="btn btn-xs" onClick={() => move(i, 1)} disabled={i === order.length - 1} aria-label="Move later">↓</button>
            </li>
          ))}
        </ol>
      );
      break;
    }
    case 'pins': {
      const v = value || [];
      control = <PinChoice pins={pins} selected={v} name={id} onToggle={(eid) => onChange(v.includes(eid) ? v.filter((x) => x !== eid) : [...v, eid])} />;
      break;
    }
    case 'pin_one':
      control = <PinChoice pins={pins} selected={value ? [value] : []} name={id} single onToggle={(eid) => onChange(eid)} />;
      break;
    case 'ioc_list': {
      const rows = value || [];
      const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
      control = (
        <div className="ioc-rows">
          {rows.map((r, i) => (
            <div className="ioc-row" key={i}>
              <select className="input" value={r.type} onChange={(e) => set(i, { type: e.target.value })} aria-label="Indicator type">
                {['domain', 'ip', 'sha256', 'url', 'email', 'file'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <input className="input mono grow" value={r.value} onChange={(e) => set(i, { value: e.target.value })} placeholder="value" aria-label="Indicator value" spellCheck={false} />
              <button type="button" className="btn btn-xs" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove indicator">×</button>
            </div>
          ))}
          <div className="ioc-add">
            <button type="button" className="btn btn-sm" onClick={() => onChange([...rows, { type: 'domain', value: '' }])}>Add indicator</button>
            {cs.iocs.filter((c) => !rows.some((r) => r.value === c.value)).length > 0 && (
              <button type="button" className="link" onClick={() => onChange([...rows, ...cs.iocs.filter((c) => !rows.some((r) => r.value === c.value)).map((c) => ({ type: c.type, value: c.value }))])}>
                Copy indicators already on the case
              </button>
            )}
          </div>
        </div>
      );
      break;
    }
    case 'checks':
      control = (
        <ul className="checks">
          {f.items.map((c) => <li key={c.id} className={c.done ? 'done' : ''}><span className="check-mark" aria-hidden="true">{c.done ? '✓' : '○'}</span>{c.label}<span className="sr">{c.done ? ' (done)' : ' (not done)'}</span></li>)}
        </ul>
      );
      break;
    default:
      control = null;
  }

  const linked = links || [];
  return (
    <div className={`fld${fb ? ` fld-${fb.verdict}` : ''}`} data-tour="fld" data-fld={f.id}>
      <div className="fld-head">
        <label className="fld-label" id={`${id}-l`} htmlFor={['text', 'longtext', 'host', 'account'].includes(f.type) ? id : undefined}>{f.label}</label>
        {fb && <Verdict v={fb.verdict} supported={fb.supported} />}
      </div>
      {f.help && <p className="fld-help">{f.help}</p>}
      {control}
      {f.linkable && (
        <div className="linker">
          <button type="button" className="link" onClick={() => setLinkOpen(!linkOpen)} aria-expanded={linkOpen}>
            {linked.length ? `${linked.length} supporting event${linked.length === 1 ? '' : 's'} linked` : 'Link supporting evidence'}
          </button>
          {linkOpen && <PinChoice pins={pins} selected={linked} name={`${id}-link`} onToggle={(eid) => onLinks(linked.includes(eid) ? linked.filter((x) => x !== eid) : [...linked, eid])} />}
        </div>
      )}
      {fb?.message && <p className="fld-msg">{fb.message}</p>}
      {f.hintAvailable && <HintLink f={f} cs={cs} locked={fb?.locked} />}
    </div>
  );
}

function StageForm({ cs, onCase }) {
  const st = cs.current;
  const [values, setValues] = useState(st.draft?.values || {});
  const [links, setLinks] = useState(st.draft?.links || {});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const confirmRef = useRef(null);
  useEffect(() => { if (confirm) confirmRef.current?.focus(); }, [confirm]);
  const dirty = useRef(false);

  // Lets the guided tour read the answers as they stand, for a pre-check.
  const latest = useRef({ values, links });
  latest.current = { values, links };
  useEffect(() => {
    const me = { stage: st.id, get: () => latest.current };
    bridge.form = me;
    return () => { if (bridge.form === me) bridge.form = null; };
  }, [st.id]);

  // Save the draft shortly after each change so a reload loses nothing. Refused for a moment (429/503
  // with a short Retry-After), it is saved once more after that wait, unless the form changed or closed
  // meanwhile (the next change saves anyway); the answers stay in the form either way.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    if (!dirty.current) return undefined;
    const t = setTimeout(() => {
      dirty.current = false;
      api.draft(cs.id, { values, links }).catch((e) => {
        if ((e.status !== 429 && e.status !== 503) || !(e.retryAfter > 0 && e.retryAfter <= 60)) return;
        setTimeout(() => { if (mounted.current && !dirty.current) api.draft(cs.id, latest.current).catch(() => {}); }, e.retryAfter * 1000);
      });
    }, 700);
    return () => clearTimeout(t);
  }, [values, links, cs.id]);

  const fb = Object.fromEntries((st.feedback || []).map((f) => [f.id, f]));
  const multi = st.attempts > 1;
  const left = st.attempts - st.attemptsUsed;

  const submit = async (finalize) => {
    setBusy(true);
    setErr(null);
    try {
      const vals = { ...values };
      for (const f of st.fields) {
        if (f.type === 'order' && vals[f.id]?.length !== f.items.length) vals[f.id] = f.items.map((i) => i.id);
        if (f.type === 'ioc_list') vals[f.id] = (vals[f.id] || []).filter((r) => r.value.trim());
      }
      const out = await api.submit(cs.id, { values: vals, links, finalize });
      setConfirm(false);
      onCase(out.case);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stage-form" data-tour="stage-form" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
      {multi && st.attemptsUsed > 0 && (
        <p className="note">{st.noFinalize
          ? 'Returned with notes. Accepted answers are locked. Correct the others and submit again.'
          : `Review round ${st.attemptsUsed} of ${st.attempts} returned. Accepted findings are locked. ${left} round${left === 1 ? '' : 's'} left.`}</p>
      )}
      {st.fields.map((f) => (
        <Field
          key={f.id} f={f} cs={cs} fb={fb[f.id]}
          value={values[f.id]} links={links[f.id]}
          onChange={(v) => { dirty.current = true; setValues((p) => ({ ...p, [f.id]: v })); }}
          onLinks={(v) => { dirty.current = true; setLinks((p) => ({ ...p, [f.id]: v })); }}
        />
      ))}
      <ErrorNote error={err} onDismiss={() => setErr(null)} />
      <div className="stage-actions">
        <button type="submit" className="btn btn-primary" data-tour="submit" disabled={busy}>{busy ? 'Submitting…' : st.submitLabel || 'Submit'}</button>
        {multi && !st.noFinalize && st.attemptsUsed > 0 && !confirm && <button type="button" className="btn" onClick={() => setConfirm(true)} disabled={busy}>Finalise as is</button>}
        {confirm && (
          <span className="confirm" role="group" aria-label="Confirm finalising">
            Unaccepted findings will score zero.
            <button type="button" className="btn btn-danger btn-sm" ref={confirmRef} onClick={() => submit(true)} disabled={busy}>Finalise findings</button>
            <button type="button" className="link" onClick={() => setConfirm(false)}>Keep working</button>
          </span>
        )}
      </div>
    </form>
  );
}

function Monitor({ cs, onCase }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const a = cs.alert;
  if (!a) {
    return (
      <div className="queue-empty">
        <h3>Alert queue</h3>
        <p>No open alerts. Logs are streaming from {cs.sources.length} sources and detection rules are evaluating them.</p>
        <p className="muted">{cs.environment}</p>
      </div>
    );
  }
  const age = Math.max(0, Math.round((now - a.firedAt) / 1000));
  return (
    <div className="queue" data-tour="queue">
      <h3>Alert queue <span className="count-badge">1</span></h3>
      <article className="queue-item">
        <p className="meta">{a.rule}, {clock(a.firedAt)} UTC, waiting {duration(age)}</p>
        <h4>{a.title}</h4>
        <p><Severity level={a.severity} /> {a.entity.host || a.entity.ip}, {a.entity.user}</p>
        <ErrorNote error={err} />
        <button
          type="button" className="btn btn-primary" data-tour="ack" disabled={busy}
          onClick={async () => { setBusy(true); try { onCase(await api.ack(cs.id)); } catch (e) { setErr(e); setBusy(false); } }}
        >
          {busy ? 'Opening ticket…' : 'Acknowledge and open ticket'}
        </button>
      </article>
    </div>
  );
}

export function StageReview({ stage, onClose }) {
  return (
    <section className="review">
      <header className="card-head">
        <h3>{stage.label}: submitted{stage.score ? `, ${stage.score.pct}%` : ''}{stage.result ? `, ${stage.result.toLowerCase()}` : ''}</h3>
        <button type="button" className="link" onClick={onClose}>Close review</button>
      </header>
      {!stage.review?.length && <p className="muted">Detailed scoring for this stage is released when the ticket is closed.</p>}
      <dl className="review-list">
        {(stage.review || []).map((r) => (
          <div key={r.label}>
            <dt>{r.label}</dt>
            <dd>
              {r.answer !== undefined && <span className="break">{r.answer}</span>}
              <Verdict v={r.verdict} supported={r.supported} />
              {r.detail && <span className="muted">{r.detail}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <p className="muted">Expected answers and explanations are released in the after-action review when the ticket is closed.</p>
    </section>
  );
}

export default function Workflow({ cs, onCase, review, setReview, ctx }) {
  const st = cs.current;
  const reviewed = review ? cs.stages.find((s) => s.id === review && s.status === 'done') : null;
  return (
    <aside className="workflow" id="soc-workflow" tabIndex={-1} aria-label="Workflow" data-tour="workflow">
      {reviewed && <StageReview stage={reviewed} onClose={() => setReview(null)} />}
      {cs.status === 'closed' && (
        <div className="closed-card" data-tour="closed-card">
          <p className="meta">Ticket closed {stamp(cs.closedAt)} UTC</p>
          <p className="score"><span className="score-n">{cs.report.score}</span><span className="score-of">/ 100</span></p>
          <p className="band">{cs.report.band}</p>
          <button type="button" className="btn btn-primary" onClick={() => ctx.goTab('report')}>Open after-action review</button>
          <p className="muted">The case file is read-only. Evidence, history and logs remain available.</p>
        </div>
      )}
      {st && (
        <>
          <header className="wf-head" data-tour="wf-head">
            <p className="meta">{st.tier === 'L1' ? 'Tier 1 analyst' : st.tier === 'L2' ? 'Tier 2 analyst' : 'Tier 3 incident responder'}</p>
            <h2>{st.kind === 'monitor' ? 'Monitor the queue' : st.label}</h2>
            {st.intro && <p className="wf-intro">{st.intro}</p>}
          </header>
          {st.kind === 'monitor' && <Monitor cs={cs} onCase={onCase} />}
          {st.kind === 'form' && <StageForm key={st.id} cs={cs} onCase={onCase} />}
          {st.kind === 'response' && <ResponsePanel key={st.id} cs={cs} onCase={onCase} />}
        </>
      )}
    </aside>
  );
}
