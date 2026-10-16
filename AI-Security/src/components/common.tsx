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
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <div className="stack small">{children}</div>
        <div className="row mt" style={{ justifyContent: "flex-end" }}>
          {actions}
        </div>
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <label className="field">{label}</label>
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
