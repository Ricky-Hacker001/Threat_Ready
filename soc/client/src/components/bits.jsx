import React from 'react';

export const pad = (n, w = 2) => String(n).padStart(w, '0');

export function clock(ts, ms = false) {
  const d = new Date(ts);
  const base = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return ms ? `${base}.${pad(d.getUTCMilliseconds(), 3)}` : base;
}

export function stamp(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${clock(ts)}`;
}

export function duration(sec) {
  if (sec == null) return '-';
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${pad(Math.floor((sec % 3600) / 60))}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${pad(sec % 60)}s`;
  return `${sec}s`;
}

export const SOURCE_LABEL = {
  proxy: 'Proxy', dns: 'DNS', email: 'Email', edr: 'Endpoint', winsec: 'Windows', firewall: 'Firewall', audit: 'Audit',
  vpn: 'VPN', idp: 'Identity', winsys: 'Windows system', fileaudit: 'File audit', web: 'Web', m365: 'Mail audit', aws: 'AWS',
};

export function SourceTag({ source }) {
  return <span className={`src src-${source}`}>{SOURCE_LABEL[source] || source}</span>;
}

export function Severity({ level }) {
  if (!level) return null;
  return <span className={`sev sev-${level}`}>{level[0].toUpperCase() + level.slice(1)}</span>;
}

const VERDICT = { correct: 'Accepted', partial: 'Partly accepted', incorrect: 'Not accepted' };
export function Verdict({ v, supported }) {
  return (
    <span className={`verdict verdict-${v}`}>
      {VERDICT[v] || v}
      {v === 'correct' && supported === false ? ', not corroborated' : ''}
    </span>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p>{children}</p>}
    </div>
  );
}

export function ErrorNote({ error, onDismiss }) {
  if (!error) return null;
  const problems = error.body?.problems;
  return (
    <div className="note note-bad" role="alert">
      <div>
        <strong>{error.message || String(error)}</strong>
        {problems && <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      </div>
      {onDismiss && <button type="button" className="link" onClick={onDismiss}>Dismiss</button>}
    </div>
  );
}

// Classify a value so the UI can offer the right pivot.
export function indicatorKind(key, value) {
  const v = String(value);
  if (/^[a-f0-9]{64}$/i.test(v)) return 'hash';
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return 'ip';
  if (['dest_host', 'query'].includes(key) && v.includes('.')) return 'domain';
  if (key === 'from' && v.includes('@')) return 'domain';
  return null;
}

// Render "k=v k2="v 2"" with dimmed keys.
export function KvLine({ text }) {
  const parts = [];
  const re = /([a-z_0-9]+)=("(?:[^"\\]|\\.)*"|\S*)/g;
  let m;
  let last = 0;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<span className="k" key={i++}>{m[1]}=</span>);
    parts.push(m[2]);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export function useLocal(key, initial) {
  const [v, setV] = React.useState(() => {
    try { return window.localStorage.getItem(key) ?? initial; } catch { return initial; }
  });
  const set = (x) => {
    setV(x);
    try { window.localStorage.setItem(key, x); } catch { /* storage unavailable */ }
  };
  return [v, set];
}
