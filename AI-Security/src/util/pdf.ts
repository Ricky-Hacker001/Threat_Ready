/** Real downloadable PDF export (jsPDF, lazy-loaded). Branded ThreatReady / Aerovant. */
import { BRAND } from "@/brand/brand";
import logoNavyWhiteBg from "@/assets/aerovant-logo.png";
import type { ScoreBreakdown } from "@/engine/types";

async function toDataUrl(src: string): Promise<{ url: string; w: number; h: number } | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // white background behind the navy logo for the (white) PDF page
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    return { url: canvas.toDataURL("image/png"), w: img.naturalWidth, h: img.naturalHeight };
  } catch {
    return null;
  }
}

export interface PdfInput {
  learner: string;
  scenarioTitle: string;
  level: string;
  score: ScoreBreakdown;
  evidence: string;
  detection: string;
  retestSummary: string;
  recommendations: string[];
  kind: "scenario" | "final";
  extraLines?: string[];
}

export async function downloadReportPdf(input: PdfInput): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 48;
  let y = margin;

  const logo = await toDataUrl(logoNavyWhiteBg);
  if (logo) {
    const w = 120;
    const h = (logo.h / logo.w) * w;
    doc.addImage(logo.url, "PNG", margin, y, w, h);
    y += h + 6;
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(26, 23, 74);
  doc.text(`${BRAND.productName} — ${input.kind === "final" ? "Analyst Report" : "Scenario Report"}`, margin, y + 14);
  y += 30;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(90, 90, 110);
  doc.text(`${BRAND.poweredByLine}`, margin, y);
  y += 14;
  doc.text(`Learner: ${input.learner}    Generated: ${new Date().toLocaleString()}`, margin, y);
  y += 10;
  doc.setDrawColor(210, 214, 224);
  doc.line(margin, y, pageW - margin, y);
  y += 24;

  // Title + score
  doc.setTextColor(20, 20, 30);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text(`${input.scenarioTitle} — ${input.level}`, margin, y);
  y += 20;
  doc.setFontSize(26);
  doc.setTextColor(input.score.passed ? 25 : 170, input.score.passed ? 140 : 70, input.score.passed ? 90 : 70);
  doc.text(`${input.score.total} / 100  ${input.score.passed ? "PASS" : "FAIL"}`, margin, y);
  y += 26;

  // Breakdown
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(20, 20, 30);
  doc.text("Score breakdown", margin, y);
  y += 16;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(60, 60, 75);
  for (const line of input.score.lines) {
    doc.text(line, margin, y, { maxWidth: pageW - margin * 2 });
    y += 13;
    if (y > 760) {
      doc.addPage();
      y = margin;
    }
  }
  y += 8;

  const section = (title: string, lines: string[]) => {
    if (y > 740) {
      doc.addPage();
      y = margin;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(20, 20, 30);
    doc.text(title, margin, y);
    y += 15;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(60, 60, 75);
    for (const l of lines) {
      doc.text(l, margin, y, { maxWidth: pageW - margin * 2 });
      y += 13;
    }
    y += 8;
  };

  section("Investigation", [`Evidence: ${input.evidence}`, `Detection: ${input.detection}`, `Re-test: ${input.retestSummary}`]);
  if (input.extraLines?.length) section("Summary", input.extraLines);
  section("Recommended next practice", input.recommendations.length ? input.recommendations : ["—"]);

  doc.setFontSize(8);
  doc.setTextColor(140, 140, 155);
  doc.text(
    `${BRAND.company} · ${BRAND.productFamily} · training environment — all data synthetic.`,
    margin,
    doc.internal.pageSize.getHeight() - 24,
  );

  doc.save(`${BRAND.productShort.replace(/\s+/g, "-")}-${input.scenarioTitle.replace(/\s+/g, "-")}.pdf`);
}
