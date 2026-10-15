import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

/* ---------- Toggle ---------- */
export function Toggle({ checked, onChange, disabled, label, id }: {
  checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean; label: string; id?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      className="tw-toggle"
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
    />
  );
}

/* ---------- Tabs ---------- */
export function Tabs<T extends string>({ tabs, value, onChange, variant = 'main' }: {
  tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void; variant?: 'main' | 'sub';
}) {
  const cls = variant === 'main' ? 'tw-tab' : 'tw-subtab';
  return (
    <div className={variant === 'main' ? 'tw-tabs' : 'tw-subtabs'} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" data-guide={`tab:${t.id}`} aria-selected={t.id === value} className={`${cls}${t.id === value ? ' active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Notes ---------- */
const NOTE_ICON = { info: Info, warn: AlertTriangle, bad: XCircle, ok: CheckCircle2 };
const NOTE_COLOR = { info: 'var(--tw-info)', warn: 'var(--tw-warn)', bad: 'var(--tw-bad)', ok: 'var(--tw-ok)' };
export function Note({ kind = 'info', children }: { kind?: keyof typeof NOTE_ICON; children: ReactNode }) {
  const Icon = NOTE_ICON[kind];
  return (
    <div className={`tw-note ${kind}`} role={kind === 'bad' ? 'alert' : undefined}>
      <Icon size={15} color={NOTE_COLOR[kind]} />
      <div>{children}</div>
    </div>
  );
}

/* ---------- Section ---------- */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="tw-section">
      <h2 className="tw-section-title">{title}</h2>
      {children}
    </section>
  );
}

/* ---------- Form row ---------- */
export function Row({ label, htmlFor, children, error, hint }: {
  label: ReactNode; htmlFor?: string; children: ReactNode; error?: string; hint?: ReactNode;
}) {
  return (
    <>
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="lbl">{label}</span>}
      <div className="ctl">{children}</div>
      {error ? <div className="err" role="alert">{error}</div> : null}
      {hint ? <div className="hint">{hint}</div> : null}
    </>
  );
}

/* ---------- Dialog ---------- */
export function Dialog({ title, onClose, children, footer, size = 'md' }: {
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.x)');
    first?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="tw-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`tw-modal ${size === 'sm' ? 'sm' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="tw-modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="tw-rowbtn x" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="tw-modal-body">{children}</div>
        {footer ? <div className="tw-modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Confirm({ title, message, confirmLabel = 'Continue', danger, onConfirm, onCancel }: {
  title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      size="sm"
      footer={<>
        <button className="tw-btn" onClick={onCancel}>Cancel</button>
        <button data-guide="confirm" className={`tw-btn ${danger ? 'tw-btn-danger' : 'tw-btn-primary'}`} onClick={onConfirm}>{confirmLabel}</button>
      </>}
    >
      <div style={{ padding: '10px 16px' }}>{message}</div>
    </Dialog>
  );
}

/* ---------- Check mark cell ---------- */
export function Tick({ on }: { on: boolean }) {
  return on
    ? <CheckCircle2 size={17} className="tw-check" aria-label="Enabled" />
    : <span className="sr-only">Disabled</span>;
}

export function SimTag({ children = 'Simulated' }: { children?: ReactNode }) {
  return <span className="tw-sim-tag">{children}</span>;
}
