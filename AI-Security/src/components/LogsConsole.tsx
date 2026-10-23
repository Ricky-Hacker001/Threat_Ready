import React, { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/state/store";
import type { LogEvent, LogType } from "@/engine/types";

const TYPES: (LogType | "all")[] = ["all", "prompt", "response", "retrieval", "toolcall", "usage", "supplychain"];

export function LogsConsole() {
  const { state, dispatch } = useApp();
  const at = state.attempt!;
  const [q, setQ] = useState("");
  const [type, setType] = useState<LogType | "all">("all");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [selected, setSelected] = useState<LogEvent | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 40;
  const detailHeading = useRef<HTMLHeadingElement>(null);
  /** The row button that opened the detail, to return focus to on Close. */
  const opener = useRef<HTMLButtonElement | null>(null);

  // The detail panel opens below the table: bring it into view and move focus to it.
  useEffect(() => {
    if (!selected) return;
    detailHeading.current?.focus({ preventScroll: true });
    detailHeading.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const closeDetail = () => {
    setSelected(null);
    if (opener.current?.isConnected) opener.current.focus();
  };

  const marked = new Set(at.state.markedEvidenceIds);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return at.state.logs
      .filter((e) => (type === "all" ? true : e.type === type))
      .filter((e) => (onlyFlagged ? e.severity === "high" || e.severity === "critical" : true))
      .filter((e) =>
        ql === ""
          ? true
          : JSON.stringify(e.fields).toLowerCase().includes(ql) ||
            e.sessionId.toLowerCase().includes(ql) ||
            e.type.includes(ql),
      )
      .sort((a, b) => a.ts - b.ts);
  }, [at.state.logs, q, type, onlyFlagged]);

  const pages = Math.ceil(filtered.length / pageSize);
  const view = filtered.slice(page * pageSize, page * pageSize + pageSize);

  return (
    <div className="grid" style={{ gridTemplateColumns: "1fr", gap: 14 }}>
      <div className="card">
        <div className="row between wrap" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>AI Logs Console</h3>
          <span className="pill info">{at.state.markedEvidenceIds.length} marked as evidence</span>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <input
            className="input"
            style={{ maxWidth: 260 }}
            placeholder="Search fields, session…"
            aria-label="Search logs"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
          />
          <select className="select" style={{ width: "auto" }} aria-label="Event type" value={type} onChange={(e) => { setType(e.target.value as never); setPage(0); }}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <label className="row small">
            <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
            High / critical only
          </label>
          <button className="btn sm ghost" onClick={() => { setQ(""); setType("all"); setOnlyFlagged(false); setPage(0); }}>
            Clear filters
          </button>
          <span className="small muted">{filtered.length} events</span>
        </div>
      </div>

      <div className="card scroll" style={{ maxHeight: 460 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Session</th>
              <th>Severity</th>
              <th>Summary</th>
              <th style={{ width: 92 }}>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {view.map((e) => (
              <tr key={e.id} className={marked.has(e.id) ? "row-evidence" : ""}>
                <td className="mono">{new Date(e.ts).toISOString().slice(11, 19)}</td>
                <td>{e.type}</td>
                <td className="mono small">{e.sessionId}</td>
                <td>
                  <SevPill sev={e.severity} />
                </td>
                <td>
                  <button
                    type="button"
                    className="cell-btn"
                    title="Show event detail"
                    aria-expanded={selected?.id === e.id}
                    onClick={(ev) => {
                      opener.current = ev.currentTarget;
                      setSelected(e);
                    }}
                  >
                    {summarise(e)}
                  </button>
                </td>
                <td>
                  <button
                    className={`btn sm ${marked.has(e.id) ? "primary" : "ghost"}`}
                    aria-pressed={marked.has(e.id)}
                    aria-label={`${marked.has(e.id) ? "Marked" : "Mark"} as evidence: ${e.type} at ${new Date(e.ts).toISOString().slice(11, 19)}`}
                    onClick={() => dispatch({ t: "toggleEvidence", eventId: e.id })}
                  >
                    {marked.has(e.id) ? "Marked" : "Mark"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pages > 1 && (
          <div className="row between mt">
            <button className="btn sm ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              ← Prev
            </button>
            <span className="small muted">
              Page {page + 1} / {pages}
            </span>
            <button className="btn sm ghost" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
              Next →
            </button>
          </div>
        )}
      </div>

      {selected && (
        <div className="card">
          <div className="row between">
            <h3 style={{ margin: 0 }} ref={detailHeading} tabIndex={-1}>
              Event detail
            </h3>
            <button className="btn sm ghost" onClick={closeDetail}>
              Close
            </button>
          </div>
          <table className="data mt" style={{ tableLayout: "fixed" }}>
            <tbody>
              {Object.entries(selected.fields).map(([k, v]) => (
                <tr key={k}>
                  <td style={{ width: "min(160px, 38%)", color: "var(--text-2)", overflowWrap: "anywhere" }}>{k}</td>
                  <td className="mono" style={{ overflowWrap: "anywhere" }}>{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SevPill({ sev }: { sev: LogEvent["severity"] }) {
  const cls = sev === "critical" || sev === "high" ? "red" : sev === "medium" ? "amber" : "grey";
  return <span className={`pill ${cls}`}>{sev}</span>;
}

function summarise(e: LogEvent): string {
  const f = e.fields;
  switch (e.type) {
    case "prompt":
      return `${f.role}: ${String(f.prompt).slice(0, 70)}`;
    case "response":
      return `${f.canaryHit ? "⚠ canary · " : ""}${String(f.response).slice(0, 70)}`;
    case "retrieval":
      return `${f.role} → ${f.docId} (${f.classification}) acl=${f.acl}`;
    case "toolcall":
      return `${f.tool} by ${f.callerRole} approval=${f.approval}`;
    case "usage":
      return `${f.user} in=${f.inTokens} out=${f.outTokens} ₹${f.costINR}`;
    case "supplychain":
      return `${f.artefact} hash=${f.hash} scan=${f.scan}`;
    default:
      return "";
  }
}
