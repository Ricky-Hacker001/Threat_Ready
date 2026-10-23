import { createContext, useContext, useState, useCallback, useEffect, useId, useRef, cloneElement, isValidElement, type ReactNode, type ReactElement } from 'react';

// ---------- toasts ----------
// Results are announced: success/info through a polite status region, errors through an alert
// region. Errors stay until dismissed (WCAG 2.2.1); other toasts fade after a few seconds.
type Toast = { id: number; text: string; kind: 'ok' | 'err' | 'info' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setList(l => l.filter(t => t.id !== id)), []);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setList(l => [...l.slice(-4), { id, text, kind }]);
    if (kind !== 'err') setTimeout(() => dismiss(id), 6000);
  }, [dismiss]);
  const item = (t: Toast) => <div key={t.id} className={`toast ${t.kind}`}>
    <span className="toast-text">{t.text}</span>
    <button type="button" className="toast-x" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">✕</button>
  </div>;
  return <ToastCtx.Provider value={push}>
    {children}
    <div className="toasts">
      <div role="alert">{list.filter(t => t.kind === 'err').map(item)}</div>
      <div role="status" aria-live="polite">{list.filter(t => t.kind !== 'err').map(item)}</div>
    </div>
  </ToastCtx.Provider>;
}

export const SEV_ORDER = ['Critical', 'High', 'Medium', 'Low'];
export const Sev = ({ s }: { s: string }) => <span className={`badge sev-${s}`}>{s}</span>;
export function StatusBadge({ status }: { status: string }) {
  const cls = status.startsWith('Verified') ? 'st-Verified' : status === 'Confirmed' ? 'st-Confirmed' : status === 'Documented' ? 'st-Documented' : status.startsWith('Remediated') ? 'st-Remediated' : 'st-none';
  return <span className={`badge ${cls}`}>{status}</span>;
}

// ---------- raw HTTP viewers ----------
// Scrollable, so they are focusable and named for keyboard and screen-reader users.
export function RawRequest({ r, host, label = 'Raw HTTP request' }: { r: any; host: string; label?: string }) {
  const target = r.path + (r.query ? `?${r.query}` : '');
  const cookie = Object.entries(r.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
  const lines: ReactNode[] = [];
  lines.push(<div key="rl"><span className="hl-status">{r.method}</span> {target} HTTP/1.1</div>);
  lines.push(<div key="host"><span className="hl-key">Host</span>: {host}</div>);
  for (const [k, v] of Object.entries(r.headers || {})) { if (k.toLowerCase() === 'cookie' || k.toLowerCase() === 'host') continue; lines.push(<div key={'h' + k}><span className="hl-key">{titleCase(k)}</span>: {String(v)}</div>); }
  if (cookie) lines.push(<div key="ck"><span className="hl-key">Cookie</span>: {cookie}</div>);
  if (r.body) { lines.push(<div key="sp">&nbsp;</div>); lines.push(<div key="body">{r.body}</div>); }
  return <pre className="raw" tabIndex={0} aria-label={label}>{lines}</pre>;
}

export function RawResponse({ r, label = 'Raw HTTP response' }: { r: any; label?: string }) {
  const lines: ReactNode[] = [];
  lines.push(<div key="sl"><span className="hl-status">HTTP/1.1 {r.status} {r.statusText}</span></div>);
  for (const [k, v] of Object.entries(r.headers || {})) lines.push(<div key={'h' + k}><span className="hl-key">{titleCase(k)}</span>: {String(v)}</div>);
  lines.push(<div key="sp">&nbsp;</div>);
  lines.push(<div key="body">{r.body}</div>);
  return <pre className="raw" tabIndex={0} aria-label={label}>{lines}</pre>;
}

function titleCase(k: string) { return k.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('-'); }

/** A labelled form control: the label is tied to the single child control by id. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  const auto = useId();
  const child = isValidElement(children) ? children as ReactElement<{ id?: string }> : null;
  const id = child?.props.id || auto;
  return <div><label className="fld" htmlFor={child ? id : undefined}>{label}</label>{child ? cloneElement(child, { id }) : children}</div>;
}

// ---------- dialogs ----------
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab inside `ref`, calls onEscape on Escape, and returns focus to the opener on unmount. */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, onEscape?: () => void, active = true) {
  const esc = useRef(onEscape); esc.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const before = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') || el;
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!ref.current) return;
      if (e.key === 'Escape' && esc.current) { e.preventDefault(); esc.current(); return; }
      if (e.key !== 'Tab') return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(n => n.offsetParent !== null || n === document.activeElement);
      if (!items.length) { e.preventDefault(); return; }
      const a = items[0], z = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === a || document.activeElement === ref.current)) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (before?.isConnected) before.focus(); };
  }, [active]);
}

/** Modal dialog: role, aria-modal, labelled by its title, focus moved in and trapped, Escape, focus restored. */
export function Dialog({ title, onClose, children, maxWidth, backdropCloses = true }: { title: string; onClose?: () => void; children: ReactNode; maxWidth?: number; backdropCloses?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, onClose);
  return <div className="modal-back" onClick={() => { if (backdropCloses && onClose) onClose(); }}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref} style={maxWidth ? { maxWidth } : undefined} onClick={e => e.stopPropagation()}>
      <h2 id={titleId} className="modal-title">{title}</h2>
      {children}
    </div>
  </div>;
}

/** Tracks a media query (e.g. the narrow-screen drawer breakpoint). */
export function useMedia(query: string) {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches;
  const [m, setM] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

/** Decorative glyphs (emoji, arrows) are hidden from screen readers; meaning is carried by text. */
export const Deco = ({ children }: { children: ReactNode }) => <span aria-hidden="true">{children}</span>;
