import React, { useState } from "react";
import { useApp } from "@/state/store";
import { CONTROL_CATALOG, LAYER_ORDER, type ControlDef } from "@/scenarios/controlCatalog";
import type { GuardrailConfig, Layer } from "@/engine/types";
import { Switch } from "./common";

export function GuardrailPanel() {
  const { state } = useApp();
  const at = state.attempt!;
  const [open, setOpen] = useState<Layer | null>(at.scenario.map.fix.includes("output") ? "outputGuard" : "systemPrompt");

  return (
    <div className="stack">
      <div className="card">
        <h3>Guardrail Panel</h3>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Configure defences. Every control changes the simulation — then run a re-test. A saved setting is not
          proof: the re-test decides. Fixing at the wrong layer loses points, and over-aggressive controls that
          block real customers also cost you.
        </p>
      </div>
      {LAYER_ORDER.map((layer) => {
        const cat = CONTROL_CATALOG[layer];
        const isOpen = open === layer;
        return (
          <div key={layer} className="card" style={{ padding: 0 }}>
            <button
              className="row between"
              style={{
                width: "100%",
                background: "none",
                border: "none",
                color: "var(--text-0)",
                padding: "14px 18px",
                cursor: "pointer",
                font: "inherit",
                fontWeight: 600,
              }}
              onClick={() => setOpen(isOpen ? null : layer)}
              aria-expanded={isOpen}
            >
              <span>{cat.title}</span>
              <span className="muted">{isOpen ? "▲" : "▼"}</span>
            </button>
            {isOpen && (
              <div style={{ padding: "0 18px 16px" }} className="stack">
                {cat.controls.map((c) => (
                  <ControlRow key={c.key} layer={layer} def={c} cfg={at.state.guardrails} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ControlRow({ layer, def, cfg }: { layer: Layer; def: ControlDef; cfg: GuardrailConfig }) {
  const { dispatch } = useApp();
  const cur = cfg[layer]?.[def.key];

  const set = (value: unknown) => dispatch({ t: "setGuardrail", layer, key: def.key, value });

  return (
    <div className="card" style={{ background: "var(--bg-2)", padding: 12 }}>
      <div className="row between wrap" style={{ gap: 10 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 600 }}>{def.label}</div>
          <div className="small muted">{def.help}</div>
        </div>
        <div>
          {def.type === "toggle" && (
            <Switch checked={cur === true} onChange={(v) => set(v)} label={def.label} />
          )}
          {def.type === "number" && (
            <input
              className="input"
              style={{ width: 120 }}
              type="number"
              value={cur === undefined ? "" : Number(cur)}
              placeholder={def.default !== undefined ? String(def.default) : ""}
              onChange={(e) => set(e.target.value === "" ? undefined : Number(e.target.value))}
            />
          )}
          {def.type === "list" && (
            <input
              className="input"
              style={{ width: 200 }}
              placeholder="comma,separated"
              value={Array.isArray(cur) ? (cur as string[]).join(", ") : ""}
              onChange={(e) =>
                set(
                  e.target.value
                    .split(",")
                    .map((x) => x.trim().toLowerCase())
                    .filter(Boolean),
                )
              }
            />
          )}
        </div>
      </div>
      <div className="row wrap small" style={{ gap: 8, marginTop: 8 }}>
        <span className="pill green" style={{ whiteSpace: "normal" }}>
          Stops: {def.stops}
        </span>
        <span className="pill amber" style={{ whiteSpace: "normal" }}>
          Can break: {def.breaks}
        </span>
      </div>
    </div>
  );
}
