import React from "react";
import type { NodeId } from "@/engine/types";
import { nodeName } from "@/screens/Briefing";

interface NodePos {
  id: NodeId;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub: string;
}

const W = 180;
const H = 58;
const NODES: NodePos[] = [
  { id: "user", x: 24, y: 40, w: W, h: H, label: "User / Chat UI", sub: "renders replies" },
  { id: "input", x: 224, y: 40, w: W, h: H, label: "Input Guard", sub: "filters, limits" },
  { id: "llm", x: 424, y: 40, w: W, h: H, label: "LLM", sub: "+ system prompt" },
  { id: "output", x: 624, y: 40, w: W, h: H, label: "Output Guard", sub: "redact, encode" },
  { id: "docs", x: 24, y: 150, w: W, h: H, label: "Uploaded Docs", sub: "files, email" },
  { id: "rag", x: 224, y: 150, w: W, h: H, label: "RAG Store", sub: "vector + ACL" },
  { id: "agent", x: 424, y: 150, w: W, h: H, label: "Agent Tools", sub: "refund, email, DB" },
  { id: "registry", x: 624, y: 150, w: W, h: H, label: "Model Registry", sub: "model files" },
];

export type MapMode = "static" | "fix-select" | "path-build" | "hidden";

export function ArchitectureMap({
  mode = "static",
  hit = [],
  fix = [],
  showFix = false,
  selectedFix = null,
  path = [],
  onFixSelect,
  onPathToggle,
}: {
  mode?: MapMode;
  hit?: NodeId[];
  fix?: NodeId[];
  showFix?: boolean;
  selectedFix?: NodeId | null;
  path?: NodeId[];
  onFixSelect?: (n: NodeId) => void;
  onPathToggle?: (n: NodeId) => void;
}) {
  if (mode === "hidden") {
    return (
      <div className="card" style={{ textAlign: "center", color: "var(--text-2)", padding: 40 }}>
        <span aria-hidden="true">🗺️ </span>The architecture map is hidden in Expert mode until the report stage.
        <div className="small">Reconstruct the attack path from your investigation.</div>
      </div>
    );
  }

  const fill = (id: NodeId): string => {
    if (hit.includes(id)) return "var(--red-bg)";
    if (showFix && fix.includes(id)) return "var(--green-bg)";
    if (selectedFix === id) return "var(--info-bg)";
    if (path.includes(id)) return "var(--info-bg)";
    return "var(--bg-2)";
  };
  const stroke = (id: NodeId): string => {
    if (hit.includes(id)) return "var(--red)";
    if (showFix && fix.includes(id)) return "var(--green)";
    if (selectedFix === id || path.includes(id)) return "var(--accent)";
    return "var(--border-strong)";
  };
  const clickable = mode === "fix-select" || mode === "path-build";

  const onClick = (id: NodeId) => {
    if (mode === "fix-select") onFixSelect?.(id);
    if (mode === "path-build") onPathToggle?.(id);
  };
  const onKey = (e: React.KeyboardEvent, id: NodeId) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick(id);
    }
  };

  // Static maps are one picture with a text alternative; interactive ones are a group of buttons
  // (an interactive child can't live inside role="img").
  const described = (ids: NodeId[]) => ids.filter((n) => n !== "logs").map(nodeName).join(" → ");
  const staticLabel =
    "AeroPay architecture: User / Chat UI → Input Guard → LLM → Output Guard, with Uploaded Docs, RAG Store, Agent Tools and Model Registry feeding the LLM, all logged to AI Logs & Monitoring." +
    (hit.length ? ` Attack path: ${described(hit)}.` : "") +
    (showFix && fix.length ? ` Correct fix: ${fix.map(nodeName).join(", ")}.` : "");
  const groupLabel =
    mode === "fix-select" ? "Architecture map: select the node where the fix belongs" : "Architecture map: select nodes in attack order";

  return (
    <div>
      <div className={clickable ? "map-scroll" : undefined}>
        <svg
          viewBox="0 0 828 306"
          width="100%"
          role={clickable ? "group" : "img"}
          aria-label={clickable ? groupLabel : staticLabel}
        >
          <defs>
            <marker id="am-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" fill="var(--border-strong)" />
            </marker>
          </defs>
          {/* connectors */}
          <g fill="none" stroke="var(--border-strong)" strokeWidth="1.5">
            <line x1="204" y1="69" x2="222" y2="69" markerEnd="url(#am-arrow)" />
            <line x1="404" y1="69" x2="422" y2="69" markerEnd="url(#am-arrow)" />
            <line x1="604" y1="69" x2="622" y2="69" markerEnd="url(#am-arrow)" />
            <path d="M314 150 V110 H514 V100" markerEnd="url(#am-arrow)" />
            <path d="M514 150 V100" markerEnd="url(#am-arrow)" />
            <path d="M714 150 V110 H534" markerEnd="url(#am-arrow)" />
            <line x1="314" y1="208" x2="422" y2="179" markerEnd="url(#am-arrow)" />
          </g>
          {NODES.map((n) => {
            const idx = path.indexOf(n.id);
            const pressed = mode === "fix-select" ? selectedFix === n.id : idx >= 0;
            return (
              <g
                key={n.id}
                className={clickable ? "am-node-btn" : undefined}
                onClick={clickable ? () => onClick(n.id) : undefined}
                onKeyDown={clickable ? (e) => onKey(e, n.id) : undefined}
                style={{ cursor: clickable ? "pointer" : "default" }}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                aria-pressed={clickable ? pressed : undefined}
                aria-label={
                  clickable
                    ? `${n.label} (${n.sub})${hit.includes(n.id) ? ", on the attack path" : ""}${mode === "path-build" && idx >= 0 ? `, step ${idx + 1}` : ""}`
                    : undefined
                }
              >
                {clickable && (
                  <rect
                    className="am-focus"
                    x={n.x - 5}
                    y={n.y - 5}
                    width={n.w + 10}
                    height={n.h + 10}
                    rx="12"
                    fill="none"
                    stroke="var(--accent-text)"
                    strokeWidth="2.5"
                  />
                )}
                <rect
                  x={n.x}
                  y={n.y}
                  width={n.w}
                  height={n.h}
                  rx="8"
                  fill={fill(n.id)}
                  stroke={stroke(n.id)}
                  strokeWidth={selectedFix === n.id || path.includes(n.id) ? 2 : 1.25}
                />
                <text x={n.x + n.w / 2} y={n.y + 24} textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--text-0)">
                  {n.label}
                </text>
                <text x={n.x + n.w / 2} y={n.y + 42} textAnchor="middle" fontSize="11" fill="var(--text-2)">
                  {n.sub}
                </text>
                {mode === "path-build" && idx >= 0 && (
                  <circle cx={n.x + n.w - 12} cy={n.y + 12} r="9" fill="var(--accent)" />
                )}
                {mode === "path-build" && idx >= 0 && (
                  <text x={n.x + n.w - 12} y={n.y + 16} textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">
                    {idx + 1}
                  </text>
                )}
              </g>
            );
          })}
          {/* logs band */}
          <rect x="24" y="240" width="780" height="44" rx="8" fill="var(--bg-3)" stroke="var(--border-strong)" strokeWidth="1.25" />
          <text x="414" y="267" textAnchor="middle" fontSize="12" fill="var(--text-1)">
            AI Logs &amp; Monitoring — prompts · retrievals · tool calls · tokens · supply chain
          </text>
        </svg>
      </div>
      <div className="row wrap small muted" style={{ gap: 14, marginTop: 6 }}>
        <Legend color="var(--red)" label="Attack path" />
        <Legend color="var(--green)" label="Correct fix" />
        <Legend color="var(--accent)" label="Your selection" />
      </div>
      {mode === "path-build" && (
        <div className="small muted" role="status">
          Select nodes in attack order (click, or Tab and press Enter; select again to remove). Current:{" "}
          {path.map(nodeName).join(" → ") || "—"}
        </div>
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="row" style={{ gap: 5 }}>
      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block" }} />
      {label}
    </span>
  );
}
