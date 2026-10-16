import React from "react";

/** The ATTACK → DETECT → FIX → RE-TEST → REPORT loop, with the fail-back edge. */
const STEPS = [
  { k: "attack", label: "1 Attack", sub: "reproduce it" },
  { k: "detect", label: "2 Detect", sub: "find evidence" },
  { k: "fix", label: "3 Fix", sub: "right layer" },
  { k: "retest", label: "4 Re-test", sub: "prove it" },
  { k: "report", label: "5 Report", sub: "write it up" },
];

export function LoopDiagram() {
  const W = 132;
  const H = 54;
  const gap = 20;
  const y = 40;
  const xs = STEPS.map((_, i) => 24 + i * (W + gap));
  const totalW = xs[xs.length - 1] + W + 24;
  return (
    <svg viewBox={`0 0 ${totalW} 150`} width="100%" role="img" aria-label="Attack, Detect, Fix, Re-test, Report loop">
      <defs>
        <marker id="loop-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="var(--border-strong)" />
        </marker>
      </defs>
      {xs.slice(0, -1).map((x, i) => (
        <line key={i} x1={x + W} y1={y + H / 2} x2={xs[i + 1]} y2={y + H / 2} stroke="var(--border-strong)" strokeWidth="1.5" markerEnd="url(#loop-arrow)" />
      ))}
      {/* fail-back edge from re-test to fix */}
      <path
        d={`M${xs[3] + W / 2} ${y + H} V${y + H + 36} H${xs[2] + W / 2} V${y + H}`}
        fill="none"
        stroke="var(--red)"
        strokeWidth="1.3"
        strokeDasharray="4 4"
        markerEnd="url(#loop-arrow)"
      />
      <text x={(xs[2] + xs[3] + W) / 2} y={y + H + 52} textAnchor="middle" fontSize="11" fill="var(--red)">
        re-test fails → back to fix
      </text>
      {STEPS.map((s, i) => (
        <g key={s.k}>
          <rect
            x={xs[i]}
            y={y}
            width={W}
            height={H}
            rx="8"
            fill={s.k === "fix" ? "var(--info-bg)" : "var(--bg-2)"}
            stroke={s.k === "fix" ? "var(--accent)" : "var(--border-strong)"}
            strokeWidth={s.k === "fix" ? 2 : 1.25}
          />
          <text x={xs[i] + W / 2} y={y + 23} textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--text-0)">
            {s.label}
          </text>
          <text x={xs[i] + W / 2} y={y + 40} textAnchor="middle" fontSize="11" fill="var(--text-2)">
            {s.sub}
          </text>
        </g>
      ))}
    </svg>
  );
}
