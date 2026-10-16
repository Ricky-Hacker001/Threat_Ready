import React, { useState } from "react";
import { useApp } from "@/state/store";
import { LoopDiagram } from "@/components/LoopDiagram";
import { ArchitectureMap } from "@/components/ArchitectureMap";
import { NOTEBOOK_INTRO, FOUNDATIONS, GLOSSARY, NOTEBOOK_TASKS } from "@/data/notebook";
import { TASK_META, getScenarioByTaskLevel } from "@/scenarios";
import { downloadNotebookPdf } from "@/util/notebookPdf";
import { nodeName } from "./Briefing";

export function Learning() {
  const { dispatch } = useApp();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      await downloadNotebookPdf();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="crumbs">
        <span style={{ cursor: "pointer" }} onClick={() => dispatch({ t: "mission" })}>
          Mission Control
        </span>
        <span className="sep">/</span>
        <span style={{ color: "var(--text-0)" }}>Learning Notebook</span>
      </div>

      <div className="row between wrap">
        <div>
          <h1 style={{ margin: 0 }}>{NOTEBOOK_INTRO.title}</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            A self-contained study guide — read it here or download the full PDF for offline learning.
          </p>
        </div>
        <button className="btn primary" onClick={download} disabled={busy}>
          {busy ? "Preparing…" : "⬇ Download PDF"}
        </button>
      </div>

      <div className="card">
        <p>{NOTEBOOK_INTRO.blurb}</p>
        <h3>How to get the most from this lab</h3>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {NOTEBOOK_INTRO.principles.map((p, i) => (
            <li key={i} style={{ marginBottom: 6 }}>{p}</li>
          ))}
        </ul>
      </div>

      {/* Foundations */}
      <h2 style={{ marginTop: 8 }}>Part 1 · Foundations</h2>
      <p className="muted small" style={{ marginTop: -6 }}>
        New to AI security? Start here. These explain how an AI assistant is built and where it can go wrong.
      </p>
      {FOUNDATIONS.map((s, i) => (
        <div className="card" key={i}>
          <h3>{s.heading}</h3>
          {s.body.map((p, j) => (
            <p key={j} className="small">{p}</p>
          ))}
          {s.heading.startsWith("The defender's loop") && (
            <div className="mt">
              <LoopDiagram />
            </div>
          )}
          {s.heading.startsWith("How an AI assistant") && (
            <div className="mt">
              <ArchitectureMap mode="static" />
            </div>
          )}
        </div>
      ))}

      {/* Glossary */}
      <div className="card">
        <h3>Glossary — the words you'll meet</h3>
        <table className="data">
          <tbody>
            {GLOSSARY.map((t) => (
              <tr key={t.term}>
                <td style={{ width: 170, fontWeight: 600, color: "var(--text-0)" }}>{t.term}</td>
                <td className="small">{t.def}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Per-task deep dives */}
      <h2 style={{ marginTop: 8 }}>Part 2 · The ten attacks, in depth</h2>
      <p className="muted small" style={{ marginTop: -6 }}>
        Each task has a theory section, how it works, a hands-on walkthrough, and how to detect and fix it.
      </p>

      {NOTEBOOK_TASKS.map((t) => {
        const meta = TASK_META.find((m) => m.id === t.taskId)!;
        const sc = getScenarioByTaskLevel(t.taskId, "foundation");
        return (
          <details className="card" key={t.taskId} open={t.taskId === 1}>
            <summary style={{ cursor: "pointer", listStyle: "none" }}>
              <div className="row between wrap">
                <h3 style={{ margin: 0 }}>
                  Task {t.taskId}: {meta.title}
                </h3>
                <span className="pill grey">OWASP {meta.owasp}</span>
              </div>
              <p className="small muted" style={{ margin: "6px 0 0" }}>{t.oneLiner}</p>
            </summary>

            <div className="stack" style={{ marginTop: 12 }}>
              <Block title="In plain terms">
                <p className="small" style={{ fontStyle: "italic" }}>{t.analogy}</p>
                {t.theory.map((p, i) => <p key={i} className="small">{p}</p>)}
              </Block>
              <Block title="How it works">
                {t.mechanism.map((p, i) => <p key={i} className="small">{p}</p>)}
              </Block>
              <Block title="Try it in the lab">
                <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  {t.walkthrough.map((p, i) => <li key={i} style={{ marginBottom: 4 }}>{p}</li>)}
                </ol>
              </Block>
              {sc && (
                <div className="card" style={{ background: "var(--bg-2)" }}>
                  <div className="small muted" style={{ marginBottom: 6 }}>
                    Attack &amp; fix flow — attack path in red, correct fix in green:
                  </div>
                  <ArchitectureMap mode="static" hit={sc.map.hit} fix={sc.map.fix} showFix />
                  <div className="small muted" style={{ marginTop: 6 }}>
                    Attacks {sc.map.hit.filter((n) => n !== "logs").map(nodeName).join(" → ")} · fix at{" "}
                    {sc.map.fix.map(nodeName).join(", ")}.
                  </div>
                </div>
              )}
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Block title="Why it matters">
                  {t.impact.map((p, i) => <p key={i} className="small">{p}</p>)}
                </Block>
                <Block title="How to detect it">
                  {t.detect.map((p, i) => <p key={i} className="small">{p}</p>)}
                </Block>
                <Block title="How to fix it">
                  {t.fix.map((p, i) => <p key={i} className="small">{p}</p>)}
                </Block>
                <Block title="Common mistakes">
                  {t.pitfalls.map((p, i) => <p key={i} className="small" style={{ color: "var(--amber)" }}>{p}</p>)}
                </Block>
              </div>
              {t.terms.length > 0 && (
                <div className="row wrap small" style={{ gap: 8 }}>
                  {t.terms.map((term) => (
                    <span key={term.term} className="pill grey" title={term.def}>
                      {term.term}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </details>
        );
      })}

      <div className="row">
        <button className="btn ghost" onClick={() => dispatch({ t: "mission" })}>
          Back to Mission Control
        </button>
        <button className="btn primary" onClick={download} disabled={busy}>
          {busy ? "Preparing…" : "⬇ Download the full notebook (PDF)"}
        </button>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--accent)", marginBottom: 2 }}>{title}</div>
      {children}
    </div>
  );
}
