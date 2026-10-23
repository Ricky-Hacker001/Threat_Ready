import React from "react";
import type { Level } from "@/engine/types";

export function LevelTag({ level }: { level: Level }) {
  const cls = level === "foundation" ? "green" : level === "intermediate" ? "info" : "amber";
  return <span className={`pill ${cls} tag-level`}>{level}</span>;
}

export function Switch({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  id?: string;
}) {
  return (
    <span className="switch" role="presentation">
      <input
        type="checkbox"
        aria-label={label}
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" />
      <span className="knob" />
    </span>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog: focus moves inside on open (to `[data-autofocus]`, else the first control — put the safe
 * choice first), Tab is kept inside, Escape and the backdrop close it, and focus returns to the
 * control that opened it.
 */
export function Modal({
  title,
  children,
  onClose,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  actions?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    (dialog.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0] ?? dialog).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // The opener may be gone (e.g. the screen changed); then the new screen manages focus.
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div
        ref={ref}
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId}>{title}</h3>
        <div className="stack small">{children}</div>
        <div className="row wrap mt" style={{ justifyContent: "flex-end" }}>
          {actions}
        </div>
      </div>
    </div>
  );
}

/** "Mission Control / … / current" trail; the first item goes back to Mission Control. */
export function Crumbs({ onHome, trail }: { onHome: () => void; trail: React.ReactNode[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <button type="button" className="crumb-link" onClick={onHome}>
        Mission Control
      </button>
      {trail.map((item, i) => {
        const last = i === trail.length - 1;
        return (
          <React.Fragment key={i}>
            <span className="sep" aria-hidden="true">/</span>
            <span aria-current={last ? "page" : undefined} style={last ? { color: "var(--text-0)" } : undefined}>
              {item}
            </span>
          </React.Fragment>
        );
      })}
    </nav>
  );
}

export function Field({
  label,
  children,
  hint,
  htmlFor,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  /** The id of the control, so the label names it. */
  htmlFor?: string;
}) {
  return (
    <div>
      <label className="field" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <div className="small muted" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return (
    <div className="card" style={{ textAlign: "center", color: "var(--text-2)", padding: 32 }}>
      {text}
    </div>
  );
}
