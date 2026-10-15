import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { stamp, clock, ErrorNote, SOURCE_LABEL } from './bits.jsx';
import LogTable from './LogTable.jsx';

function Facts({ facts }) {
  if (!facts?.length) return null;
  return <dl className="facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}
function Notes({ notes }) {
  if (!notes?.length) return null;
  return <ul className="notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul>;
}

const VERDICT_LABEL = { malicious: 'Malicious', suspicious: 'Suspicious', unknown: 'No verdict', clean: 'Clean', internal: 'Internal' };

function Result({ run, ctx }) {
  const r = run.result;
  switch (r.kind) {
    case 'reputation':
      return (
        <>
          <p className="result-line"><span className={`rep rep-${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span> <span className="mono break">{r.indicator}</span> <span className="muted">{r.type}, vendor detections {r.detections}</span></p>
          <Facts facts={r.facts} /><Notes notes={r.notes} />
        </>
      );
    case 'facts':
      return r.found ? <><Facts facts={r.facts} /><Notes notes={r.notes} /></> : <Notes notes={r.notes} />;
    case 'change':
      return r.items.length ? (
        <table className="grid">
          <thead><tr><th>Change</th><th>Title</th><th>Scope</th><th>Owner</th><th>Window (UTC)</th><th>Status</th></tr></thead>
          <tbody>
            {r.items.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.id}</td>
                <td>{c.title}{c.detail && <div className="muted">{c.detail}</div>}</td>
                <td>{c.scope}</td><td>{c.owner}</td>
                <td className="mono window"><span>{stamp(c.start)}</span><span>to {stamp(c.end)}</span></td>
                <td>{c.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted">No change records match "{r.filter}".</p>;
    case 'decode':
      return r.output ? <><p className="muted">{r.encoding}</p><pre className="code">{r.output}</pre></> : <Notes notes={r.notes} />;
    case 'sweep':
      return (
        <>
          <p className="result-line">
            <strong>{r.total.toLocaleString()}</strong> event{r.total === 1 ? '' : 's'} mention <span className="mono break">{r.indicator}</span>
            {r.window.from && <span className="muted"> in logs from {stamp(r.window.from)} to {clock(r.window.to)} UTC</span>}
            {r.total > 0 && <button type="button" className="link" onClick={() => ctx.onSearch(r.indicator.includes(' ') ? `"${r.indicator}"` : r.indicator)}>Open in log search</button>}
          </p>
          {r.rows.length > 0 && (
            <table className="grid">
              <thead><tr><th>Host or mailbox</th><th>First seen</th><th>Last seen</th><th className="num">Events</th><th>Sources</th></tr></thead>
              <tbody>
                {r.rows.map((x) => (
                  <tr key={x.entity}>
                    <td>{x.entity}</td><td className="mono">{stamp(x.first)}</td><td className="mono">{stamp(x.last)}</td><td className="num">{x.count}</td>
                    <td>{Object.entries(x.sources).map(([s, n]) => `${SOURCE_LABEL[s] || s} ${n}`).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {r.earliest.length > 0 && <><h4>Earliest matching events</h4><LogTable events={r.earliest} ctx={ctx} /></>}
        </>
      );
    case 'proctree':
      return (
        <>
          <p className="muted">{r.total} process-creation events on {r.host}{r.filter ? `; showing branches containing "${r.filter}"` : ''}{r.truncated ? '; first 400 rows shown, add a filter to narrow' : ''}.</p>
          {r.nodes.length === 0 && <p className="muted">No processes match.</p>}
          <ul className="tree">
            {r.nodes.map((n, i) => (
              <li key={`${n.id || 'root'}-${i}`} style={{ paddingLeft: `${n.depth * 20}px` }} className={n.synthetic ? 'tree-root' : ''}>
                <span className="tree-time mono">{n.synthetic ? 'running' : clock(n.ts)}</span>
                <span className="tree-main">
                  <span className="tree-img">{String(n.image).split('\\').pop()}</span> <span className="muted">pid {n.pid}{n.user ? `, ${n.user}` : ''}</span>
                  {n.command_line && <span className="tree-cmd mono">{n.command_line}</span>}
                </span>
                {!n.synthetic && ctx.canPin && (
                  <button type="button" className={`btn btn-xs${ctx.pinned.has(n.id) ? ' btn-on' : ''}`} onClick={() => ctx.onPin({ id: n.id }, ctx.pinned.has(n.id))}>{ctx.pinned.has(n.id) ? 'Pinned' : 'Pin'}</button>
                )}
              </li>
            ))}
          </ul>
        </>
      );
    case 'sandbox':
      return r.found ? (
        <>
          <p className="result-line"><span className={`rep rep-${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span> <span className="muted">threat score {r.score}/100</span></p>
          <Facts facts={r.facts} />
          {r.behaviours?.length > 0 && <><h4>Behaviour</h4><ul className="notes">{r.behaviours.map((b) => <li key={b}>{b}</li>)}</ul></>}
          {r.network?.length > 0 && <><h4>Network</h4><ul className="notes mono">{r.network.map((b) => <li key={b}>{b}</li>)}</ul></>}
          {r.dropped?.length > 0 && <><h4>Files written</h4><ul className="notes mono break">{r.dropped.map((b) => <li key={b}>{b}</li>)}</ul></>}
        </>
      ) : <Notes notes={r.notes} />;
    default:
      return <pre className="code">{JSON.stringify(r, null, 2)}</pre>;
  }
}

export default function ToolsPanel({ cs, ctx, prefill, onCase }) {
  const [tool, setTool] = useState('reputation');
  const [input, setInput] = useState('');
  const [filter, setFilter] = useState('');
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const def = cs.tools.find((t) => t.id === tool);

  const run = async (t = tool, i = input, f = filter) => {
    setBusy(true);
    setErr(null);
    try {
      const out = await api.tool(cs.id, t, i, f);
      const label = cs.tools.find((x) => x.id === t).label;
      setRuns((prev) => [{ id: Date.now(), tool: t, label, input: i, at: Date.now(), result: out.result }, ...prev].slice(0, 30));
      onCase(out.case);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!prefill) return;
    setTool(prefill.tool);
    setInput(prefill.input);
    setFilter('');
    if (cs.tools.find((t) => t.id === prefill.tool)?.available) run(prefill.tool, prefill.input, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  const listId = def.id === 'asset' || def.id === 'proctree' ? 'dl-hosts' : def.id === 'user' ? 'dl-accounts' : undefined;

  return (
    <div className="panel tools">
      <nav className="tool-list" aria-label="Tools" data-tour="tool-list">
        {cs.tools.map((t) => (
          <button type="button" key={t.id} data-tour="tool" data-tool={t.id} className={`tool${tool === t.id ? ' is-on' : ''}`} onClick={() => { setTool(t.id); setErr(null); }} aria-current={tool === t.id}>
            <span>{t.label}</span>
            {!t.available && <span className="lock">{cs.status === 'open' ? `Tier ${t.tier}` : 'Unavailable'}</span>}
          </button>
        ))}
      </nav>
      <div className="tool-main">
        <form className="tool-form" data-tour="tool-form" onSubmit={(e) => { e.preventDefault(); run(); }}>
          <p className="lead">{def.desc}</p>
          {!def.available && (
            <p className="note">{cs.status === 'closed' ? 'The ticket is closed; tools are no longer available.' : cs.status === 'monitoring' ? 'Open a ticket by acknowledging an alert to use tools.' : `${def.label} requires Tier ${def.tier} access. It unlocks when the ticket is escalated.`}</p>
          )}
          <div className="tool-inputs">
            {def.multiline
              ? <textarea className="input mono grow" rows={3} value={input} onChange={(e) => setInput(e.target.value)} placeholder={def.input} aria-label={def.input} spellCheck={false} disabled={!def.available} />
              : <input className="input mono grow" value={input} onChange={(e) => setInput(e.target.value)} placeholder={def.input} aria-label={def.input} list={listId} spellCheck={false} disabled={!def.available} />}
            {def.filter && <input className="input mono" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={def.filter} aria-label={def.filter} spellCheck={false} disabled={!def.available} />}
            <button type="submit" className="btn btn-primary" disabled={!def.available || busy || (!def.optional && !input.trim())}>{busy ? 'Running…' : def.run}</button>
          </div>
          <datalist id="dl-hosts">{cs.directory.hosts.map((h) => <option key={h.name} value={h.name}>{h.role}</option>)}</datalist>
          <datalist id="dl-accounts">{cs.directory.accounts.map((a) => <option key={a.sam} value={a.sam}>{a.name}</option>)}</datalist>
        </form>
        <ErrorNote error={err} onDismiss={() => setErr(null)} />
        <div className="scroll" data-tour="tool-results">
          {!runs.length && <p className="muted pad">Results appear here. Every run is recorded in the case history.</p>}
          {runs.map((r) => (
            <section className="card" key={r.id}>
              <header className="card-head">
                <h3>{r.label}{r.input ? <span className="mono break run-input"> {r.input.length > 70 ? `${r.input.slice(0, 70)}…` : r.input}</span> : ''}</h3>
                <span className="muted">{clock(r.at)} UTC</span>
              </header>
              <Result run={r} ctx={ctx} />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
