/**
 * Renders both downloadable PDFs with the real jsPDF build (no DOM: the logo step is skipped, exactly as
 * it is in a browser that refuses the image) and checks that a well-formed multi-page PDF comes out.
 * Added with the jspdf 2.x → 4.x upgrade (security patch 2) so the next bump cannot silently break export.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsPDF } from "jspdf";
import { downloadReportPdf } from "./pdf";
import { downloadNotebookPdf } from "./notebookPdf";

type Saved = { name: string; pages: number; bytes: Uint8Array };

function captureSave(): { saved: Saved[]; restore: () => void } {
  const saved: Saved[] = [];
  const api = (jsPDF as unknown as { API: Record<string, unknown> }).API;
  const original = api.save;
  api.save = function (this: jsPDF, name: string) {
    saved.push({ name, pages: this.getNumberOfPages(), bytes: new Uint8Array(this.output("arraybuffer")) });
    return this;
  };
  return { saved, restore: () => { api.save = original; } };
}

const header = (b: Uint8Array) => String.fromCharCode(...b.slice(0, 8));

describe("PDF export (jsPDF)", () => {
  let restore = () => {};
  afterEach(() => { restore(); vi.restoreAllMocks(); });

  it("scenario report renders a single-page PDF with the branded filename", async () => {
    const cap = captureSave();
    restore = cap.restore;
    await downloadReportPdf({
      learner: "Analyst",
      scenarioTitle: "Prompt Injection",
      level: "foundation",
      score: { total: 82, passed: true, lines: ["Evidence 20/20", "Detection 18/20", "Fix 24/30", "Re-test 20/30"] } as never,
      evidence: "Injected instruction in the retrieved document",
      detection: "Log line with tool call outside policy",
      retestSummary: "Blocked after fix",
      recommendations: ["Task 2", "Task 5"],
      kind: "scenario",
    });
    expect(cap.saved).toHaveLength(1);
    const [pdf] = cap.saved;
    expect(pdf.name).toMatch(/-Prompt-Injection\.pdf$/);
    expect(header(pdf.bytes)).toMatch(/^%PDF-1\.\d/);
    expect(pdf.pages).toBe(1);
  });

  it("learning notebook renders every task as its own page", async () => {
    const cap = captureSave();
    restore = cap.restore;
    await downloadNotebookPdf();
    expect(cap.saved).toHaveLength(1);
    const [pdf] = cap.saved;
    expect(pdf.name).toBe("AI-Security-Lab-Learning-Notebook.pdf");
    expect(header(pdf.bytes)).toMatch(/^%PDF-1\.\d/);
    // Cover + foundations/glossary + one page per notebook task (10) at minimum.
    expect(pdf.pages).toBeGreaterThanOrEqual(12);
    expect(pdf.bytes.byteLength).toBeGreaterThan(20_000);
    // Footer page numbers are stamped on every page.
    const text = new TextDecoder("latin1").decode(pdf.bytes);
    expect(text).toContain(`${pdf.pages} / ${pdf.pages}`);
  });
});
