import React, { useEffect, useRef, useState } from "react";
import { useApp } from "@/state/store";
import { BRAND } from "@/brand/brand";
import type { Role } from "@/engine/types";
import { variantCountFor } from "@/engine/validation";

const ROLES: Role[] = ["customer", "intern", "support", "manager", "attacker"];

export function TargetApp() {
  const { state, dispatch } = useApp();
  const at = state.attempt!;
  const s = at.scenario;
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view inside the scrolling log.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [at.chat.length]);

  const nVariants = variantCountFor(s.level);
  const variants = [s.attack, ...s.bypassVariants.slice(0, Math.max(nVariants, s.level === "foundation" ? 0 : nVariants))];
  // At foundation only the primary attack is offered; at I/E, primary + its bypasses.
  const offered = s.level === "foundation" ? [s.attack] : variants;

  return (
    <div className="grid" style={{ gridTemplateColumns: "1fr", gap: 16 }}>
      <div className="card">
        <div className="row between wrap">
          <h3 style={{ margin: 0 }}>
            {BRAND.targetOrg} · chat with {BRAND.assistantName}
          </h3>
          <label className="row small">
            <span className="muted">Role:</span>
            <select
              className="select"
              style={{ width: "auto" }}
              value={at.state.role}
              onChange={(e) => dispatch({ t: "setRole", role: e.target.value as Role })}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="small muted" style={{ marginBottom: 10 }}>
          Session {at.state.attemptId.slice(-6)} · acting as <strong>{at.state.role}</strong>. Markdown renders
          safely; any HTML/script is shown as inert text.
        </div>

        {/* role=log: new messages (only) are announced politely; focusable so it can be scrolled by keyboard. */}
        <div
          className="chat-log"
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={`Conversation with ${BRAND.assistantName}`}
          tabIndex={0}
        >
          {at.chat.length === 0 && (
            <div className="muted small" style={{ textAlign: "center", padding: 16 }}>
              Start by asking a normal question, or run an attack below.
            </div>
          )}
          {at.chat.map((m, i) => (
            <div key={i} className={`msg ${m.from} ${m.vuln ? "vuln" : ""}`}>
              <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 2 }}>
                {m.from === "user" ? at.state.role : BRAND.assistantName}
              </div>
              {m.text}
              {m.demo && (
                <div className="pill amber" style={{ marginTop: 8, whiteSpace: "normal" }}>
                  Educational note: {m.demo}
                </div>
              )}
            </div>
          ))}
        </div>

        <form
          className="row mt"
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim()) return;
            dispatch({ t: "chat", prompt: input.trim() });
            setInput("");
          }}
        >
          <input
            className="input"
            aria-label={`Message ${BRAND.assistantName}`}
            placeholder={`Message ${BRAND.assistantName}…`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!input.trim()}>
            Send
          </button>
        </form>
      </div>

      {/* Attack templates */}
      <div className="card">
        <h3>Attacker workbench</h3>
        <p className="small muted">
          Run a scripted, simulated attack. If your defences don't stop it, Aero produces the unsafe outcome
          and evidence is written to the logs. Nothing executes for real.
        </p>
        <div className="stack">
          {offered.map((v, i) => (
            <div key={v.id} className="card" style={{ background: "var(--bg-2)", padding: 12 }}>
              <div className="row between wrap">
                <strong className="small">
                  {i === 0 ? "Primary attack" : `Bypass ${i}`}: {v.label}
                </strong>
                <button
                  className="btn sm"
                  onClick={() => dispatch({ t: "chat", prompt: v.template, attack: i === 0 ? "primary" : v.id })}
                >
                  Run attack
                </button>
              </div>
              <div className="small mono muted" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
                {v.template}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Benign suite */}
      <div className="card">
        <h3>Legitimate traffic (must keep working)</h3>
        <div className="row wrap">
          {s.benignTests.map((b) => (
            <button key={b.id} className="btn sm ghost" onClick={() => dispatch({ t: "chat", prompt: b.prompt })}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
