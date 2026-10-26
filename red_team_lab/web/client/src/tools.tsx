import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { RawRequest, RawResponse, Sev, StatusBadge, Field, SEV_ORDER, useToast } from './ui';
import { api, BASE } from './api';

export interface ToolProps {
  def: any; view: any; status: any; sid: string;
  act: (type: string, params?: any) => Promise<any>;
  pushRepeater: (req: any) => void;
  repeater: any; setRepeater: (r: any) => void;
  gotoTab: (t: string) => void;
  browserPrefill?: { method: string; url: string; body?: string; seq: number } | null;
  termInject?: { cmd: string; seq: number } | null;
}

const histById = (view: any, id: string) => view.history.find((h: any) => h.id === id);

// Trusted navigation shim appended to the sandboxed target frame. It keeps clicks and form submits
// inside the simulation (posting them to the parent, which calls browser.navigate) instead of letting
// the frame navigate the real origin. It also turns blocking dialogs (alert/confirm/prompt) raised by
// XSS payloads into a non-blocking on-page banner — a safe, visible proof that script executed.
// The per-frame nonce ties its messages to the frame instance the lab page created (see BrowserTool).
const navShim = (nonce: string) => `<script>(function(){
  var nonce=${JSON.stringify(nonce)};
  function send(method,url,body){ try{ parent.postMessage({__trlab:1,type:'nav',nonce:nonce,method:method,url:url,body:body||''}, '*'); }catch(e){} }
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest && e.target.closest('a[href]'); if(!a) return;
    var href = a.getAttribute('href')||'';
    if(/^(https?:|mailto:|tel:)/i.test(href)){ e.preventDefault(); return; }
    if(href.indexOf('#')===0 || href.toLowerCase().indexOf('javascript:')===0){ e.preventDefault(); return; }
    e.preventDefault(); send('GET', href);
  }, true);
  document.addEventListener('submit', function(e){
    var f=e.target; if(!f||f.tagName!=='FORM') return; e.preventDefault();
    var method=(f.getAttribute('method')||'GET').toUpperCase();
    var action=f.getAttribute('action')||location.pathname;
    var p=new URLSearchParams();
    for(var i=0;i<f.elements.length;i++){ var el=f.elements[i]; if(!el.name||el.disabled) continue; if((el.type==='checkbox'||el.type==='radio')&&!el.checked) continue; p.append(el.name, el.value); }
    if(method==='GET') send('GET', action + (action.indexOf('?')>-1?'&':'?') + p.toString());
    else send('POST', action, p.toString());
  }, true);
  function banner(m){ try{ var d=document.createElement('div'); d.textContent='\\u26A0 script executed in your session: '+m; d.style.cssText='position:fixed;top:0;left:0;right:0;background:#b4231c;color:#fff;font:600 13px system-ui,sans-serif;padding:7px 12px;z-index:99999'; (document.body||document.documentElement).appendChild(d); setTimeout(function(){d.remove();},5000);}catch(e){} }
  window.alert=function(m){ banner('alert('+m+')'); };
  window.confirm=function(m){ banner('confirm('+m+')'); return false; };
  window.prompt=function(m){ banner('prompt('+m+')'); return null; };
})();</scr`+`ipt>`;

function SaveEvidence({ act, historyId }: { act: ToolProps['act']; historyId?: string }) {
  if (!historyId) return null;
  return <button className="wl-btn sm" onClick={() => act('evidence.add', { historyId })}>★ Save to evidence</button>;
}

/* ---------------- Embedded Browser ---------------- */
export function BrowserTool({ def, view, act, pushRepeater, browserPrefill }: ToolProps) {
  const [url, setUrl] = useState('/products');
  const [method, setMethod] = useState('GET');
  const [body, setBody] = useState('');

  // A beginner "do this step" prefill: load the fields and navigate immediately.
  useEffect(() => {
    if (!browserPrefill) return;
    const { method: m, url: u, body: b } = browserPrefill;
    setMethod(m); setUrl(u); setBody(b || '');
    act('browser.navigate', { url: u, method: m, body: m === 'POST' ? (b || '') : undefined });
  }, [browserPrefill?.seq]);
  const [cookieName, setCookieName] = useState('ac_admin');
  const [cookieVal, setCookieVal] = useState('');
  const host = def?.target?.host || 'shop.aerocart.lab';
  const lastBrowser = useMemo(() => [...view.history].reverse().find((h: any) => h.tool === 'browser' || h.tool === 'retest'), [view.history]);
  const resp = lastBrowser?.response;

  // Keep the embedded browser inside the simulation: a trusted shim in the sandboxed frame forwards
  // link clicks and form submits to the lab (browser.navigate) instead of navigating the real origin.
  // The frame is the server's /target-frame.html (its own sandboxed policy, so the lab's pages can keep
  // the strict platform policy while XSS payloads still run in the target): a fresh instance per
  // response, which announces `ready` and is then handed the response body with this instance's nonce.
  const frameRef = useRef<HTMLIFrameElement>(null);
  const actRef = useRef(act); actRef.current = act;
  const frameKey = lastBrowser?.id ?? '';
  const nonce = useMemo(() => newNonce(), [frameKey]);
  const frameDoc = useMemo(() => !resp ? '' : resp.contentType === 'text/html' ? resp.body + navShim(nonce) : `<pre style="font-family:monospace;padding:12px;white-space:pre-wrap">${escapeHtml(resp.body)}</pre>`, [resp, nonce]);
  const frameState = useRef({ nonce, frameDoc }); frameState.current = { nonce, frameDoc };
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // Only the current sandboxed frame (an opaque origin serialises as "null").
      if (!frameRef.current || e.source !== frameRef.current.contentWindow || e.origin !== 'null') return;
      const d: any = e.data;
      if (!d || d.__trlab !== 1) return;
      if (d.type === 'ready') { (e.source as Window).postMessage({ nonce: frameState.current.nonce, html: frameState.current.frameDoc }, '*'); return; }
      if (d.type === 'nav' && d.nonce === frameState.current.nonce && typeof d.url === 'string')
        actRef.current('browser.navigate', { url: d.url, method: d.method === 'POST' ? 'POST' : 'GET', body: d.body || undefined });
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const links = useMemo(() => {
    if (!resp || resp.contentType !== 'text/html') return [] as { href: string; text: string }[];
    try {
      const doc = new DOMParser().parseFromString(resp.body, 'text/html');
      const out: { href: string; text: string }[] = [];
      doc.querySelectorAll('a[href]').forEach(a => { const href = a.getAttribute('href') || ''; if (href.startsWith('/')) out.push({ href, text: (a.textContent || href).trim().slice(0, 40) }); });
      return out.slice(0, 20);
    } catch { return []; }
  }, [resp]);

  const go = (u = url, m = method) => { act('browser.navigate', { url: u, method: m, body: m === 'POST' ? body : undefined }).then(() => setUrl(u)); };

  return <div>
    <div className="bchrome">
      <select className="wl-select" style={{ width: 90 }} value={method} onChange={e => setMethod(e.target.value)}><option>GET</option><option>POST</option></select>
      <span className="code2">{host}</span>
      <input className="wl-input grow mono" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') go(); }} placeholder="/path?query" />
      <button className="wl-btn primary" onClick={() => go()}>Go</button>
      <button className={`wl-btn ${view.proxy.intercepting ? 'primary' : ''}`} onClick={() => act('proxy.setIntercept', { on: !view.proxy.intercepting })} title="Toggle proxy interception">Intercept {view.proxy.intercepting ? 'on' : 'off'}</button>
    </div>
    {method === 'POST' && <textarea className="wl-area mono" style={{ marginBottom: 8 }} value={body} onChange={e => setBody(e.target.value)} placeholder="request body (e.g. username=admin&password=x)" />}

    {view.proxy.held && <div className="card" style={{ borderColor: 'var(--warn)', marginBottom: 10 }}>
      <h3 style={{ color: 'var(--warn)' }}>Request intercepted</h3>
      <RawRequest r={view.proxy.held.request} host={host} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="wl-btn primary" onClick={() => act('proxy.resolveHeld', { action: 'forward' })}>Forward</button>
        <button className="wl-btn" onClick={() => act('proxy.resolveHeld', { action: 'drop' })}>Drop</button>
        <button className="wl-btn" onClick={() => pushRepeater(view.proxy.held.request)}>Send to Repeater</button>
      </div>
    </div>}

    <div className="row" style={{ marginBottom: 6 }}>
      <span className="muted small">Address: <span className="code2">{view.browser.url}</span></span>
      {resp && <span className={`badge ${resp.status < 400 ? 'st-ok' : 'st-none'}`}>{resp.status} {resp.statusText}</span>}
      <span className="grow" />
      {lastBrowser && <button className="wl-btn sm" onClick={() => pushRepeater(lastBrowser.request)}>↗ Repeater</button>}
      <SaveEvidence act={act} historyId={lastBrowser?.id} />
    </div>

    {resp
      ? <iframe key={frameKey} ref={frameRef} className="bframe" sandbox="allow-scripts allow-forms" title="target" src={`${BASE}target-frame.html`} />
      : <div className="card muted">Enter a path and press Go to load a page. Links and forms inside the page work and stay inside the simulation (isolated sandbox). Vulnerability detection is server-side; the Proxy logs every request.</div>}

    {links.length > 0 && <div style={{ marginTop: 8 }}><span className="muted small">Links on this page:</span><br />
      {links.map((l, i) => <span key={i} className="linkchip" onClick={() => go(l.href, 'GET')}>{l.text || l.href}</span>)}</div>}

    <div className="card" style={{ marginTop: 10 }}>
      <h3>Browser cookie jar</h3>
      <div className="small mono">{Object.keys(view.browser.cookies).length ? Object.entries(view.browser.cookies).map(([k, v]) => `${k}=${String(v).slice(0, 48)}${String(v).length > 48 ? '…' : ''}`).join('  ') : '(empty)'}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <input className="wl-input" style={{ width: 120 }} value={cookieName} onChange={e => setCookieName(e.target.value)} placeholder="name" />
        <input className="wl-input grow mono" value={cookieVal} onChange={e => setCookieVal(e.target.value)} placeholder="value (e.g. a forged ac_admin JWT)" />
        <button className="wl-btn" disabled={!cookieName || !cookieVal} onClick={() => act('browser.setCookie', { name: cookieName, value: cookieVal }).then(() => setCookieVal(''))}>Set cookie</button>
        <button className="wl-btn" onClick={() => act('browser.clearCookies')}>Clear</button>
      </div>
    </div>
  </div>;
}

/* ---------------- Proxy / HTTP history ---------------- */
export function ProxyTool({ def, view, act, pushRepeater }: ToolProps) {
  const [sel, setSel] = useState<string | null>(null);
  const host = def?.target?.host || 'shop.aerocart.lab';
  const rows = [...view.history].reverse();
  const selected = sel ? histById(view, sel) : rows[0];
  return <div>
    <div className="card" style={{ padding: 0, maxHeight: '34vh', overflow: 'auto' }}>
      <table className="htable">
        <thead><tr><th>#</th><th>Tool</th><th>Method</th><th>Path</th><th>Status</th><th>Len</th><th>Time</th><th>Flags</th></tr></thead>
        <tbody>{rows.map((h: any) => <tr key={h.id} className={selected?.id === h.id ? 'sel' : ''} onClick={() => setSel(h.id)}>
          <td className="mono">{h.id}</td><td>{h.tool}</td>
          <td className={`method m-${h.request.method}`}>{h.request.method}</td>
          <td className="mono">{h.request.path}{h.request.query ? '?' + h.request.query.slice(0, 40) : ''}</td>
          <td>{h.response.status}</td><td>{h.response.body.length}</td><td>{h.response.timeMs}ms</td>
          <td>{h.events.filter((e: string) => e !== 'web.response').map((e: string) => <span key={e} className="badge st-Confirmed" style={{ marginRight: 3 }}>{e.replace('web.', '')}</span>)}</td>
        </tr>)}</tbody>
      </table>
      {!rows.length && <div className="muted" style={{ padding: 14 }}>No requests yet. Browse the target or use the terminal; every request appears here.</div>}
    </div>
    {selected && <>
      <div className="row" style={{ margin: '10px 0' }}>
        <button className="wl-btn sm" onClick={() => pushRepeater(selected.request)}>↗ Send to Repeater</button>
        <SaveEvidence act={act} historyId={selected.id} />
        <span className="muted small">Captured {selected.at.slice(11, 19)} via {selected.tool}</span>
      </div>
      <div className="rawgrid"><div><div className="muted small" style={{ marginBottom: 4 }}>Request</div><RawRequest r={selected.request} host={host} /></div>
        <div><div className="muted small" style={{ marginBottom: 4 }}>Response</div><RawResponse r={selected.response} /></div></div>
    </>}
  </div>;
}

/* ---------------- Repeater ---------------- */
export function RepeaterTool({ def, act, repeater, setRepeater }: ToolProps) {
  const host = def?.target?.host || 'shop.aerocart.lab';
  const [resp, setResp] = useState<any>(null);
  const r = repeater || { method: 'GET', path: '/login', query: '', headers: { 'content-type': 'application/x-www-form-urlencoded' }, cookies: {}, body: "username=admin'--&password=x" };
  const set = (patch: any) => setRepeater({ ...r, ...patch });
  const headersText = Object.entries(r.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  const cookiesText = Object.entries(r.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
  const send = async () => { const res = await act('proxy.send', { request: r }); if (res?.result?.response) setResp(res.result); };
  return <div className="rawgrid">
    <div>
      <div className="row">
        <select className="wl-select" style={{ width: 90 }} value={r.method} onChange={e => set({ method: e.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m}>{m}</option>)}</select>
        <button className="wl-btn primary" onClick={send}>Send</button>
      </div>
      <Field label="Path"><input className="wl-input mono" value={r.path} onChange={e => set({ path: e.target.value })} /></Field>
      <Field label="Query string"><input className="wl-input mono" value={r.query} onChange={e => set({ query: e.target.value })} placeholder="q=shoes" /></Field>
      <Field label="Headers (one per line)"><textarea className="wl-area mono" value={headersText} onChange={e => set({ headers: parseHeaders(e.target.value) })} /></Field>
      <Field label="Cookie"><input className="wl-input mono" value={cookiesText} onChange={e => set({ cookies: parseCookies(e.target.value) })} placeholder="ac_session=...; ac_admin=..." /></Field>
      <Field label="Body"><textarea className="wl-area mono" value={r.body} onChange={e => set({ body: e.target.value })} /></Field>
    </div>
    <div>
      <div className="muted small" style={{ marginBottom: 4 }}>Response {resp && <span className={`badge ${resp.response.status < 400 ? 'st-ok' : 'st-none'}`}>{resp.response.status} {resp.response.statusText} · {resp.response.timeMs}ms · {resp.response.body.length}B</span>}</div>
      {resp ? <>
        <div className="row" style={{ marginBottom: 6 }}><SaveEvidence act={act} historyId={resp.historyId} /></div>
        <RawResponse r={resp.response} />
      </> : <div className="card muted">Edit the request and Send. Try an auth-bypass payload in the body, or iterate an id in the query.</div>}
    </div>
  </div>;
}

/* ---------------- Terminal (xterm.js) ---------------- */
export function TerminalTool({ def, act, termInject }: ToolProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const buf = useRef(''); const hist = useRef<string[]>([]); const hpos = useRef(0); const busy = useRef(false);
  const commands = (def?.terminalCommands || []) as string[];

  useEffect(() => {
    if (termRef.current || !hostRef.current) return;
    const term = new Terminal({ fontFamily: "'JetBrains Mono Variable', monospace", fontSize: 13, theme: { background: '#05080f', foreground: '#d7def0', cursor: '#6d5dfc' }, cursorBlink: true, convertEol: true });
    const fit = new FitAddon(); term.loadAddon(fit);
    term.open(hostRef.current); try { fit.fit(); } catch {}
    termRef.current = term; fitRef.current = fit;
    term.writeln('ThreatReady lab terminal — type `help`. Tools act on the lab target only (simulation).');
    prompt(term);
    term.onData(d => onData(d, term));
    const onResize = () => { try { fit.fit(); } catch {} };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); };
  }, []);

  // refit when becoming visible
  useEffect(() => { const t = setTimeout(() => { try { fitRef.current?.fit(); } catch {} }, 60); return () => clearTimeout(t); });

  const prompt = (term: Terminal) => term.write('\r\n\x1b[38;5;99manalyst@threatready\x1b[0m:\x1b[38;5;75m~\x1b[0m$ ');

  const onData = (d: string, term: Terminal) => {
    if (busy.current) return;
    const code = d.charCodeAt(0);
    if (d === '\r') { const line = buf.current; buf.current = ''; term.write('\r\n'); runLine(line, term); }
    else if (d === '\u007f') { if (buf.current.length) { buf.current = buf.current.slice(0, -1); term.write('\b \b'); } }
    else if (d === '\u001b[A') { if (hist.current.length) { hpos.current = Math.max(0, hpos.current - 1); replace(term, hist.current[hpos.current] || ''); } }
    else if (d === '\u001b[B') { if (hist.current.length) { hpos.current = Math.min(hist.current.length, hpos.current + 1); replace(term, hist.current[hpos.current] || ''); } }
    else if (d === '\t') { const comp = complete(buf.current, commands); if (comp) { replace(term, comp); } }
    else if (code >= 32) { buf.current += d; term.write(d); }
  };
  const replace = (term: Terminal, s: string) => { term.write('\r\x1b[K\x1b[38;5;99manalyst@threatready\x1b[0m:\x1b[38;5;75m~\x1b[0m$ ' + s); buf.current = s; };

  const runLine = async (line: string, term: Terminal) => {
    const cmd = line.trim();
    if (!cmd) { prompt(term); return; }
    hist.current.push(cmd); hpos.current = hist.current.length;
    if (cmd === 'clear') { term.clear(); prompt(term); return; }
    busy.current = true;
    try { const r = await act('terminal.exec', { line: cmd }); const out = r?.result?.output ?? ''; if (out) term.write(out.replace(/\n/g, '\r\n')); }
    catch (e: any) { term.write(`\x1b[31m${e.message}\x1b[0m`); }
    busy.current = false; prompt(term);
  };

  // Beginner "Run in Terminal": echo the command at the prompt, then run it so output shows in xterm.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !termInject || busy.current) return;
    term.write(termInject.cmd + '\r\n');
    runLine(termInject.cmd, term);
  }, [termInject?.seq]);

  return <div className="termwrap"><div className="xterm-host" ref={hostRef} /></div>;
}
function complete(buf: string, commands: string[]): string | null {
  if (buf.includes(' ')) return null;
  const m = commands.filter(c => c.startsWith(buf));
  return m.length === 1 ? m[0] + ' ' : null;
}

/* ---------------- Findings manager ---------------- */
export function FindingsTool({ status, act }: ToolProps) {
  const findings = status.findings;
  return <div>
    <p className="muted small">Confirm a vulnerability with the tools, document it with a severity and evidence, apply the correct remediation, then re-test to verify. Answer keys stay on the server.</p>
    {findings.map((f: any) => <FindingCard key={f.id} f={f} act={act} />)}
  </div>;
}
function FindingCard({ f, act }: { f: any; act: ToolProps['act'] }) {
  const [sev, setSev] = useState(f.reportedSeverity || f.severity || 'High');
  const [note, setNote] = useState(f.note || '');
  const [opt, setOpt] = useState('');
  if (!f.confirmed) return <div className="find"><div className="fh"><span className="ftitle">{f.title}</span><span className="grow" /><StatusBadge status="Not found" /></div><div className="meta muted">Not yet demonstrated. Use the browser, proxy, repeater or terminal to prove it, then it appears here with its details.</div></div>;
  return <div className="find">
    <div className="fh"><span className="ftitle">{f.title}</span> <Sev s={f.severity} /> <span className="grow" /><StatusBadge status={f.status} /></div>
    <div className="meta">{f.impact}</div>
    <div className="small muted">{f.cwe} · {f.owasp} · affected: <span className="code2">{(f.routes || []).join(', ')}</span> · proof: <span className="code2 mono">{f.proof ? `${f.proof.method} ${f.proof.path}${f.proof.query ? '?' + f.proof.query : ''}` : '—'}</span></div>

    {!f.reported && <div style={{ marginTop: 10 }}>
      <div className="row">
        <Field label="Severity"><select className="wl-select" style={{ width: 130 }} value={sev} onChange={e => setSev(e.target.value)}>{SEV_ORDER.map(s => <option key={s}>{s}</option>)}</select></Field>
        <div className="grow"><Field label="Analyst note (optional)"><input className="wl-input" value={note} onChange={e => setNote(e.target.value)} placeholder="reproduction / impact note" /></Field></div>
      </div>
      <button className="wl-btn primary sm" style={{ marginTop: 8 }} onClick={() => act('finding.report', { findingId: f.id, severity: sev, note })}>Document finding</button>
    </div>}
    {f.reported && <div className="meta small">Documented as <Sev s={f.reportedSeverity} />{f.note ? ` — “${f.note}”` : ''}</div>}

    {f.reported && !f.verified && <div style={{ marginTop: 10 }}>
      <label className="fld">Remediation — choose the fix that addresses the root cause</label>
      {f.options.map((o: any) => <label key={o.id} className="opt"><input type="radio" name={'rem-' + f.id} checked={opt === o.id} onChange={() => setOpt(o.id)} disabled={f.remediated} /> {o.label}</label>)}
      <div className="row" style={{ marginTop: 6 }}>
        {!f.remediated && <button className="wl-btn sm" disabled={!opt} onClick={() => act('finding.remediate', { findingId: f.id, optionId: opt })}>Apply remediation</button>}
        {f.remediated && <button className="wl-btn primary sm" onClick={() => act('finding.retest', { findingId: f.id })}>Re-test to verify</button>}
        {f.remediated && <span className="muted small">{f.verifyRetest}</span>}
      </div>
    </div>}

    {f.verified && <div style={{ marginTop: 10 }}>
      <div className="badge st-Verified" style={{ marginBottom: 6 }}>✓ Verified fixed</div>
      <div className="small"><b>Root cause:</b> {f.rootCause}</div>
      <div className="small"><b>Remediation:</b> {f.remediation}</div>
    </div>}
  </div>;
}

/* ---------------- Report ---------------- */
export function ReportTool({ status, act, sid }: ToolProps) {
  const toast = useToast();
  const [summary, setSummary] = useState('');
  const [report, setReport] = useState<any>(null);
  const load = () => api.report(sid).then(setReport).catch(e => toast(e.message, 'err'));
  useEffect(() => { if (status.complete) load(); }, [status.complete]);
  if (status.complete && report) return <RenderedReport report={report} />;
  if (status.complete) return <div className="muted">Loading report…</div>;
  if (status.level < 4) return <div className="card muted">The report unlocks at Level 4, after you have remediated and verified the findings. Confirmed: {status.posture.confirmed}/{status.posture.total}, verified: {status.posture.verified}/{status.posture.total}.</div>;
  return <div className="report">
    <h2>Deliver the penetration-test report</h2>
    <p className="muted small">Documented findings: {status.posture.documented}/{status.posture.total} · verified: {status.posture.verified}/{status.posture.total} · evidence items: {status.evidence.length}</p>
    <Field label="Executive summary (min 80 chars)"><textarea className="wl-area" style={{ minHeight: 120 }} value={summary} onChange={e => setSummary(e.target.value)} placeholder="Summarise the engagement: what you assessed, the key risks, and the overall posture after remediation." /></Field>
    <button className="wl-btn primary" style={{ marginTop: 10 }} disabled={summary.trim().length < 80} onClick={() => act('report.submit', { summary }).then(load)}>Submit report</button>
  </div>;
}

function RenderedReport({ report }: { report: any }) {
  const download = () => { const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${report.meta.sessionId}-report.json`; a.click(); };
  return <div className="report">
    <div className="row"><h1 style={{ flex: 1 }}>Penetration-Test Report</h1><button className="wl-btn" onClick={() => window.print()}>Print / PDF</button><button className="wl-btn" onClick={download}>Export JSON</button></div>
    <p className="small muted">{report.meta.lab} · Tester: {report.meta.learner} · Run {report.meta.run} · Generated {new Date(report.meta.generatedAt).toLocaleString()}</p>
    <div className="card" style={{ borderColor: 'var(--warn)' }}><span className="small">{report.disclosure}</span></div>

    <h2>Executive summary</h2>
    <p>{report.summary.learnerText}</p>
    <p className="small">Findings: {report.summary.confirmed} confirmed, {report.summary.documented} documented, {report.summary.verified} verified fixed, of {report.summary.total} total. Report quality score: {report.reportAssessment ? `${report.reportAssessment.total}/${report.reportAssessment.max}` : '—'}.</p>

    <h2>Scope &amp; rules of engagement</h2>
    <ul className="tight">{report.scope.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
    <p className="small muted">Out of scope: {report.outOfScope.join('; ')}</p>
    <h2>Methodology</h2>
    <ul className="tight">{report.methodology.map((m: string, i: number) => <li key={i}>{m}</li>)}</ul>

    <h2>Findings</h2>
    <table><thead><tr><th>ID</th><th>Title</th><th>Severity</th><th>Status</th><th>Affected</th><th>Reproduction</th></tr></thead>
      <tbody>{report.findings.map((f: any) => <tr key={f.id}><td>{f.id}</td><td>{f.title}</td><td>{f.severity !== '—' ? <Sev s={f.severity} /> : '—'}</td><td className="small">{f.status}</td><td className="small mono">{f.affected}</td><td className="small mono">{f.reproduction || '—'}</td></tr>)}</tbody></table>

    {report.findings.filter((f: any) => f.confirmed).map((f: any) => <div key={f.id} style={{ marginTop: 14 }}>
      <h3 style={{ marginBottom: 4 }}>{f.id} — {f.title} {f.severity !== '—' && <Sev s={f.severity} />}</h3>
      {f.impact && <p className="small"><b>Impact:</b> {f.impact}</p>}
      {f.rootCause && <p className="small"><b>Root cause:</b> {f.rootCause}</p>}
      {f.remediation && <p className="small"><b>Remediation:</b> {f.remediation}</p>}
      {f.analystNote && <p className="small"><b>Analyst note:</b> {f.analystNote}</p>}
      <p className="small"><b>Retest:</b> {f.retest}</p>
    </div>)}

    <h2>Evidence</h2>
    <table><thead><tr><th>Ref</th><th>Tool</th><th>Request</th><th>Status</th></tr></thead>
      <tbody>{report.evidence.map((e: any) => <tr key={e.id}><td className="mono">{e.id}</td><td>{e.tool}</td><td className="mono small">{e.method} {e.path}</td><td>{e.status}</td></tr>)}{!report.evidence.length && <tr><td colSpan={4} className="muted">No evidence attached.</td></tr>}</tbody></table>

    <h2>Remaining risks</h2>
    <ul className="tight">{report.remainingRisks.length ? report.remainingRisks.map((r: string, i: number) => <li key={i}>{r}</li>) : <li>All confirmed findings were remediated and verified.</li>}</ul>
    <h2>Limitations</h2>
    <ul className="tight">{report.limitations.map((l: string, i: number) => <li key={i} className="small">{l}</li>)}</ul>
  </div>;
}

/* ---------------- helpers ---------------- */
function parseHeaders(text: string): Record<string, string> { const o: Record<string, string> = {}; for (const line of text.split('\n')) { const i = line.indexOf(':'); if (i > 0) o[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); } return o; }
function parseCookies(text: string): Record<string, string> { const o: Record<string, string> = {}; for (const p of text.split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); } return o; }
function newNonce() { return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36); }
function escapeHtml(s: string) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }
