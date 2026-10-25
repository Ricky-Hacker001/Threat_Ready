import React, { useEffect, useMemo, useRef, useState } from 'react';
import LogTable from './LogTable.jsx';
import { api } from '../api.js';
import { clock, stamp, SourceTag, SOURCE_LABEL, Severity, Empty, ErrorNote } from './bits.jsx';

// ---------------------------------------------------------------------------
// Live feed
// ---------------------------------------------------------------------------
const STREAM_TEXT = { connecting: 'Connecting…', reconnecting: 'Reconnecting…', failed: 'Stream stopped, refreshing every few seconds', busy: 'Not live: too many consoles open, refreshing every few seconds', ended: 'Stream ended with the ticket', signedout: 'Not live: signed out' };

export function LiveFeed({ live, paused, setPaused, held, ctx, sources, stream, closed }) {
  const connected = stream === 'live';
  const [hidden, setHidden] = useState(() => new Set());
  const [text, setText] = useState('');
  const mounted = useRef(Date.now());
  const shown = useMemo(() => {
    const t = text.trim().toLowerCase();
    return live.filter((e) => !hidden.has(e.source) && (!t || e.raw.toLowerCase().includes(t)));
  }, [live, hidden, text]);
  const toggle = (s) => {
    const n = new Set(hidden);
    if (n.has(s)) n.delete(s); else n.add(s);
    setHidden(n);
  };
  return (
    <div className="panel">
      <div className="toolbar" data-tour="feed-toolbar">
        <span className={`live-dot${connected && !paused && !closed ? ' is-on' : ''}`} aria-hidden="true" />
        <span className="toolbar-status">
          {closed ? STREAM_TEXT.ended : !connected ? STREAM_TEXT[stream] || STREAM_TEXT.reconnecting : paused ? `Paused, ${held} new line${held === 1 ? '' : 's'} waiting` : 'Streaming'}
        </span>
        {!closed && (
          <button type="button" className="btn btn-sm" data-tour="feed-pause" onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
        )}
        <div className="chips" role="group" aria-label="Sources shown in the live feed">
          {sources.map((s) => (
            <button type="button" key={s} className={`chip${hidden.has(s) ? '' : ' chip-on'}`} aria-pressed={!hidden.has(s)} onClick={() => toggle(s)}>
              {SOURCE_LABEL[s] || s}
            </button>
          ))}
        </div>
        <input className="input input-sm grow" placeholder="Show only lines containing…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Filter live feed" />
      </div>
      <div className="scroll">
        {shown.length ? <LogTable events={shown} ctx={ctx} freshAfter={mounted.current} /> : <Empty title="No lines match">Clear the text filter or re-enable a source.</Empty>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log search
// ---------------------------------------------------------------------------
const EXAMPLES = [
  ['source:proxy dest_host:*.example', 'field match with a wildcard'],
  ['host:FS01 event_id:(4624|4625)', 'several values for one field'],
  ['source:edr powershell -user:*SYSTEM', 'free text, excluding a field value'],
  ['bytes_out>1000000', 'numeric comparison'],
  ['"net group"', 'exact phrase'],
];

export function SearchPanel({ caseId, search, setSearch, ctx, sources }) {
  const [draft, setDraft] = useState(search.q);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [help, setHelp] = useState(false);
  const [limit, setLimit] = useState(100);

  useEffect(() => { setDraft(search.q); setLimit(100); }, [search.q, search.nonce]);

  useEffect(() => {
    let dead = false;
    setBusy(true);
    setErr(null);
    api.logs(caseId, { q: search.q, source: search.source, from: search.from, to: search.to, limit })
      .then((r) => { if (!dead) setRes(r); })
      .catch((e) => { if (!dead) setErr(e); })
      .finally(() => { if (!dead) setBusy(false); });
    return () => { dead = true; };
  }, [caseId, search, limit]);

  const run = (e) => {
    e?.preventDefault();
    setSearch({ ...search, q: draft.trim(), nonce: search.nonce + 1 });
  };

  return (
    <div className="panel">
      <form className="toolbar" data-tour="search-bar" onSubmit={run}>
        <input data-tour="search-input" className="input mono grow" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder='Search logs, e.g. source:proxy dest_host:*.example' aria-label="Log query" spellCheck={false} />
        <button type="submit" className="btn btn-primary btn-sm" data-tour="search-run">Search</button>
        <button type="button" className="btn btn-sm" onClick={() => { setDraft(''); setSearch({ q: '', source: '', nonce: search.nonce + 1 }); }}>Reset</button>
        <button type="button" className="link" onClick={() => setHelp(!help)} aria-expanded={help}>Query syntax</button>
      </form>
      {help && (
        <div className="help">
          <p>Terms are combined with AND. Field names are the keys shown in each log line. Click any value in an expanded event to add it to the query.</p>
          <ul>
            {EXAMPLES.map(([q, d]) => (
              <li key={q}><button type="button" className="code-link" onClick={() => { setDraft(q); setSearch({ ...search, q, nonce: search.nonce + 1 }); }}>{q}</button> {d}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="toolbar toolbar-sub">
        <div className="chips" role="group" aria-label="Log source" data-tour="search-sources">
          <button type="button" className={`chip${!search.source ? ' chip-on' : ''}`} aria-pressed={!search.source} onClick={() => setSearch({ ...search, source: '', nonce: search.nonce + 1 })}>All sources</button>
          {sources.map((s) => (
            <button type="button" key={s} className={`chip${search.source === s ? ' chip-on' : ''}`} aria-pressed={search.source === s} onClick={() => setSearch({ ...search, source: search.source === s ? '' : s, nonce: search.nonce + 1 })}>
              {SOURCE_LABEL[s] || s}{res && !search.source && res.bySource[s] ? ` ${res.bySource[s]}` : ''}
            </button>
          ))}
        </div>
        {search.from !== undefined && (
          <span className="range">
            {clock(search.from)} to {clock(search.to)}
            <button type="button" className="link" onClick={() => setSearch({ ...search, from: undefined, to: undefined, nonce: search.nonce + 1 })}>Clear time range</button>
          </span>
        )}
        <span className="count" role="status" data-tour="search-count">{busy ? 'Searching…' : res ? `${res.total.toLocaleString()} event${res.total === 1 ? '' : 's'}, newest first` : ''}</span>
      </div>
      <ErrorNote error={err} />
      <div className="scroll">
        {res && res.events.length > 0 && <LogTable events={res.events} ctx={ctx} />}
        {res && res.events.length === 0 && !busy && <Empty title="No events match this query">Check field names against an expanded log line, or widen the time range.</Empty>}
        {res && res.total > res.events.length && (
          <div className="more"><button type="button" className="btn btn-sm" onClick={() => setLimit(limit + 200)}>Show more ({(res.total - res.events.length).toLocaleString()} remaining)</button></div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alert
// ---------------------------------------------------------------------------
function AlertCard({ alert, caseId, ctx, related }) {
  const [events, setEvents] = useState(null);
  useEffect(() => {
    let dead = false;
    api.events(caseId, alert.matched).then((r) => { if (!dead) setEvents(r.events.sort((a, b) => b.ts - a.ts)); }).catch(() => {});
    return () => { dead = true; };
  }, [caseId, alert.id]);
  return (
    <section className="card" data-tour="alert-card">
      <header className="card-head">
        <div>
          <p className="meta">{related ? 'Related alert' : 'Alert'} {alert.rule}, fired {stamp(alert.firedAt)} UTC</p>
          <h3>{alert.title}</h3>
        </div>
        <span className="sev-wrap">Rule severity <Severity level={alert.severity} /></span>
      </header>
      <p className="lead">{alert.description}</p>
      <div className="cols-2">
        <dl className="facts" data-tour="alert-facts">
          <div><dt>{alert.entity.host ? 'Host' : 'Source address'}</dt><dd>{alert.entity.host ? `${alert.entity.host} (${alert.entity.ip})` : alert.entity.ip}</dd></div>
          <div><dt>User</dt><dd>{alert.entity.user}</dd></div>
          {alert.details.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        {alert.guidance && (
          <div data-tour="alert-runbook">
            <h4>Runbook for this rule</h4>
            <ol className="steps">{alert.guidance.map((g) => <li key={g}>{g}</li>)}</ol>
          </div>
        )}
      </div>
      <div data-tour="alert-matched">
        <h4>Events that matched the rule <span className="muted">(latest {alert.matched.length} of {alert.matchedTotal})</span></h4>
        {events ? <LogTable events={events} ctx={ctx} /> : <p className="muted">Loading…</p>}
      </div>
    </section>
  );
}

export function AlertPanel({ cs, ctx }) {
  if (!cs.alert) return <div className="panel"><Empty title="No alerts in the queue">The live feed is streaming. Detection rules evaluate it continuously.</Empty></div>;
  return (
    <div className="panel">
      <div className="scroll pad">
        <AlertCard alert={cs.alert} caseId={cs.id} ctx={ctx} />
        {cs.relatedAlerts.map((a) => <AlertCard key={a.id} alert={a} caseId={cs.id} ctx={ctx} related />)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------
function PinNote({ pin, onSave, disabled }) {
  const [v, setV] = useState(pin.note || '');
  const dirty = v !== (pin.note || '');
  return (
    <form className="pin-note" onSubmit={(e) => { e.preventDefault(); onSave(v); }}>
      <input className="input input-sm grow" placeholder="Why this event matters" value={v} onChange={(e) => setV(e.target.value)} disabled={disabled} aria-label="Evidence note" />
      {dirty && <button type="submit" className="btn btn-xs">Save note</button>}
    </form>
  );
}

export function EvidencePanel({ cs, ctx, act }) {
  const [val, setVal] = useState('');
  const open = cs.status === 'open';
  const pins = [...cs.pins].sort((a, b) => a.event.ts - b.event.ts);
  return (
    <div className="panel">
      <div className="scroll pad">
        <section className="card" data-tour="pins">
          <header className="card-head"><h3>Pinned events</h3><span className="muted">{pins.length} in the case file, oldest first</span></header>
          {!pins.length && <Empty title="Nothing pinned yet">Use Pin on any log line. Pinned events stay with the ticket through every tier and are what your findings are checked against.</Empty>}
          <ul className="pins">
            {pins.map((p) => (
              <li key={p.eventId}>
                <div className="pin-head">
                  <span className="mono">{stamp(p.event.ts)}</span>
                  <SourceTag source={p.event.source} />
                  <span>{p.event.host}</span>
                  <span className="muted">pinned by {p.by}</span>
                  <span className="grow" />
                  <button type="button" className="link" onClick={() => ctx.onContext(p.event)}>Show surrounding events</button>
                  {open && <button type="button" className="link" onClick={() => ctx.onPin(p.event, true)}>Remove</button>}
                </div>
                <div className="raw-line">{p.event.raw}</div>
                <PinNote pin={p} disabled={!open} onSave={(note) => act(() => api.pin(cs.id, p.eventId, note))} />
              </li>
            ))}
          </ul>
        </section>
        <section className="card" data-tour="iocs">
          <header className="card-head"><h3>Indicators</h3><span className="muted">{cs.iocs.length} recorded</span></header>
          {!cs.iocs.length && <p className="muted">Add domains, addresses and hashes as you confirm them. They are offered as targets when blocking.</p>}
          {cs.iocs.length > 0 && (
            <table className="grid">
              <thead><tr><th>Type</th><th>Value</th><th>Added by</th><th /></tr></thead>
              <tbody>
                {cs.iocs.map((i) => (
                  <tr key={i.value}>
                    <td>{i.type}</td>
                    <td className="mono break">{i.value}</td>
                    <td className="muted">{i.by}</td>
                    <td className="row-actions">
                      <button type="button" className="link" onClick={() => ctx.onSearch(i.value)}>Search logs</button>
                      {['domain', 'ip', 'sha256'].includes(i.type) && <button type="button" className="link" onClick={() => ctx.onLookup('reputation', i.value)}>Look up</button>}
                      {open && <button type="button" className="link" onClick={() => act(() => api.removeIoc(cs.id, i.value))}>Remove</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {open && (
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (val.trim()) act(() => api.addIoc(cs.id, val.trim())).then((ok) => ok && setVal('')); }}>
              <input className="input mono grow" placeholder="Domain, IP address, SHA-256, sender or file name" value={val} onChange={(e) => setVal(e.target.value)} aria-label="New indicator" spellCheck={false} />
              <button type="submit" className="btn btn-sm">Add indicator</button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Case history
// ---------------------------------------------------------------------------
const KINDS = [['all', 'Everything'], ['stage', 'Decisions'], ['evidence', 'Evidence'], ['tool', 'Tool runs'], ['action', 'Response actions'], ['note', 'Notes'], ['system', 'System']];

export function HistoryPanel({ cs, act }) {
  const [kind, setKind] = useState('all');
  const [text, setText] = useState('');
  const rows = cs.history.filter((h) => kind === 'all' || h.kind === kind || (kind === 'system' && ['system', 'alert', 'qa'].includes(h.kind)) || (kind === 'stage' && h.kind === 'qa'));
  const stageLabel = Object.fromEntries(cs.stages.map((s) => [s.id, s.label]));
  return (
    <div className="panel">
      <div className="toolbar" data-tour="history-filters">
        <div className="chips" role="group" aria-label="Show entries">
          {KINDS.map(([k, l]) => <button type="button" key={k} className={`chip${kind === k ? ' chip-on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}
        </div>
        <span className="count">{rows.length} of {cs.history.length} entries</span>
      </div>
      <div className="scroll pad">
        {cs.status === 'open' && (
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) act(() => api.note(cs.id, text.trim())).then((ok) => ok && setText('')); }}>
            <input className="input grow" placeholder="Add a working note to the case file" value={text} onChange={(e) => setText(e.target.value)} aria-label="Working note" />
            <button type="submit" className="btn btn-sm">Add note</button>
          </form>
        )}
        <ol className="history" data-tour="history">
          {[...rows].reverse().map((h, i) => (
            <li key={`${h.ts}-${i}`} className={`h-${h.kind}`}>
              <span className="h-time mono">{stamp(h.ts)}</span>
              <span className="h-actor">{h.actor}</span>
              <span className="h-stage">{stageLabel[h.stage] || ''}</span>
              <span className="h-text">{h.text}{h.data?.raw && <span className="raw-line">{h.data.raw}</span>}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
