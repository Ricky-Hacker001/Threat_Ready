import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

// ---------- toasts ----------
type Toast = { id: number; text: string; kind: 'ok' | 'err' | 'info' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setList(l => [...l, { id, text, kind }]);
    setTimeout(() => setList(l => l.filter(t => t.id !== id)), 4200);
  }, []);
  return <ToastCtx.Provider value={push}>
    {children}
    <div className="toasts">{list.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
  </ToastCtx.Provider>;
}

export const SEV_ORDER = ['Critical', 'High', 'Medium', 'Low'];
export const Sev = ({ s }: { s: string }) => <span className={`badge sev-${s}`}>{s}</span>;
export function StatusBadge({ status }: { status: string }) {
  const cls = status.startsWith('Verified') ? 'st-Verified' : status === 'Confirmed' ? 'st-Confirmed' : status === 'Documented' ? 'st-Documented' : status.startsWith('Remediated') ? 'st-Remediated' : 'st-none';
  return <span className={`badge ${cls}`}>{status}</span>;
}

// ---------- raw HTTP viewers ----------
export function RawRequest({ r, host }: { r: any; host: string }) {
  const target = r.path + (r.query ? `?${r.query}` : '');
  const cookie = Object.entries(r.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
  const lines: ReactNode[] = [];
  lines.push(<div key="rl"><span className="hl-status">{r.method}</span> {target} HTTP/1.1</div>);
  lines.push(<div key="host"><span className="hl-key">Host</span>: {host}</div>);
  for (const [k, v] of Object.entries(r.headers || {})) { if (k.toLowerCase() === 'cookie' || k.toLowerCase() === 'host') continue; lines.push(<div key={'h' + k}><span className="hl-key">{titleCase(k)}</span>: {String(v)}</div>); }
  if (cookie) lines.push(<div key="ck"><span className="hl-key">Cookie</span>: {cookie}</div>);
  if (r.body) { lines.push(<div key="sp">&nbsp;</div>); lines.push(<div key="body">{r.body}</div>); }
  return <pre className="raw">{lines}</pre>;
}

export function RawResponse({ r }: { r: any }) {
  const lines: ReactNode[] = [];
  lines.push(<div key="sl"><span className="hl-status">HTTP/1.1 {r.status} {r.statusText}</span></div>);
  for (const [k, v] of Object.entries(r.headers || {})) lines.push(<div key={'h' + k}><span className="hl-key">{titleCase(k)}</span>: {String(v)}</div>);
  lines.push(<div key="sp">&nbsp;</div>);
  lines.push(<div key="body">{r.body}</div>);
  return <pre className="raw">{lines}</pre>;
}

function titleCase(k: string) { return k.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('-'); }

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><label className="fld">{label}</label>{children}</div>;
}
