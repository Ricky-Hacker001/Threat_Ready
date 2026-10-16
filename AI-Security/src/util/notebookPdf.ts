/** Downloadable learning-notebook PDF with drawn flow diagrams. jsPDF is lazy-loaded. */
import type { jsPDF as JsPdf } from "jspdf";
import { BRAND } from "@/brand/brand";
import logoNavy from "@/assets/aerovant-logo.png";
import { NOTEBOOK_INTRO, FOUNDATIONS, GLOSSARY, NOTEBOOK_TASKS } from "@/data/notebook";
import { TASK_META, getScenarioByTaskLevel } from "@/scenarios";
import { nodeName } from "@/screens/Briefing";
import type { NodeId } from "@/engine/types";

const NAVY: [number, number, number] = [26, 23, 74];
const INK: [number, number, number] = [30, 30, 40];
const MUTE: [number, number, number] = [95, 95, 115];
const ACCENT: [number, number, number] = [40, 70, 150];
const AMBER: [number, number, number] = [150, 95, 20];
const RED: [number, number, number] = [200, 60, 60];
const GREEN: [number, number, number] = [30, 130, 85];

/** Downscaled logo (keeps the PDF small). */
async function logoDataUrl(): Promise<string | null> {
  try {
    const img = new Image();
    img.src = logoNavy;
    await img.decode();
    const targetW = 360;
    const scale = targetW / img.naturalWidth;
    const c = document.createElement("canvas");
    c.width = targetW;
    c.height = Math.round(img.naturalHeight * scale);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}

export async function downloadNotebookPdf(): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" }) as JsPdf;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 46;
  let y = margin;

  const ensure = (need: number) => {
    if (y + need > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };
  const para = (text: string, size = 10, color = INK, lead = 13.5, indent = 0) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, pageW - margin * 2 - indent);
    for (const ln of lines) {
      ensure(lead);
      doc.text(ln, margin + indent, y);
      y += lead;
    }
  };
  const heading = (text: string, size = 13, color = NAVY, gapBefore = 8) => {
    ensure(size + 10 + gapBefore);
    y += gapBefore;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.text(text, margin, y);
    y += size + 2;
  };
  const subhead = (text: string) => {
    ensure(18);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(...ACCENT);
    doc.text(text, margin, y);
    y += 14;
  };

  // --- Cover ---
  const logo = await logoDataUrl();
  if (logo) {
    const w = 150;
    doc.addImage(logo, "PNG", margin, y, w, (466 / 1346) * w);
    y += (466 / 1346) * w + 24;
  }
  heading(NOTEBOOK_INTRO.title, 19, NAVY, 0);
  para(BRAND.poweredByLine, 9, MUTE);
  y += 6;
  para(NOTEBOOK_INTRO.blurb);
  heading("How to get the most from this lab", 12);
  NOTEBOOK_INTRO.principles.forEach((p) => para("•  " + p, 10, INK, 13.5, 6));

  // --- Part 1: Foundations ---
  doc.addPage();
  y = margin;
  heading("Part 1 · Foundations", 16, NAVY, 0);
  para("New to AI security? Start here — how an AI assistant is built and where it can go wrong.", 10, MUTE);
  FOUNDATIONS.forEach((s) => {
    heading(s.heading, 12.5);
    s.body.forEach((p) => para(p));
    if (s.heading.startsWith("The defender's loop")) {
      ensure(100);
      drawLoop(doc, margin, y + 6, pageW - margin * 2);
      y += 96;
    }
  });

  // --- Glossary ---
  heading("Glossary — the words you'll meet", 13);
  GLOSSARY.forEach((t) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...NAVY);
    ensure(14);
    doc.text(t.term + ":", margin, y);
    const w = doc.getTextWidth(t.term + ": ");
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...INK);
    const lines = doc.splitTextToSize(t.def, pageW - margin * 2 - w);
    doc.text(lines[0], margin + w, y);
    y += 13.5;
    for (let i = 1; i < lines.length; i++) {
      ensure(13.5);
      doc.text(lines[i], margin + 10, y);
      y += 13.5;
    }
  });

  // --- Part 2: per-task deep dives ---
  NOTEBOOK_TASKS.forEach((t) => {
    const meta = TASK_META.find((m) => m.id === t.taskId)!;
    const sc = getScenarioByTaskLevel(t.taskId, "foundation");
    doc.addPage();
    y = margin;
    heading(`Task ${t.taskId}: ${meta.title}`, 15, NAVY, 0);
    para(`OWASP ${meta.owasp}  ·  ${t.oneLiner}`, 9.5, MUTE);
    y += 4;

    subhead("In plain terms");
    para(t.analogy, 10, INK, 13.5);
    t.theory.forEach((p) => para(p));

    subhead("How it works");
    t.mechanism.forEach((p) => para(p));

    subhead("Try it in the lab");
    t.walkthrough.forEach((p, i) => para(`${i + 1}.  ${p}`, 10, INK, 13.5, 6));

    if (sc) {
      subhead("Attack & fix flow");
      ensure(54);
      drawTaskFlow(doc, margin, y, pageW - margin * 2, sc.map.hit, sc.map.fix);
      y += 60;
    }

    subhead("Why it matters");
    t.impact.forEach((p) => para(p));
    subhead("How to detect it");
    t.detect.forEach((p) => para(p));
    subhead("How to fix it");
    t.fix.forEach((p) => para(p));
    subhead("Common mistakes");
    t.pitfalls.forEach((p) => para(p, 10, AMBER));
  });

  // --- Footer on every page ---
  doc.setFontSize(8);
  doc.setTextColor(150, 150, 165);
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.text(`${BRAND.company} · ${BRAND.productFamily} — training environment, all data synthetic.`, margin, pageH - 22);
    doc.text(`${i} / ${n}`, pageW - margin, pageH - 22, { align: "right" });
  }

  doc.save("AI-Security-Lab-Learning-Notebook.pdf");
}

function box(doc: JsPdf, x: number, y: number, w: number, h: number, label: string, color: [number, number, number], fill?: [number, number, number]) {
  if (fill) {
    doc.setFillColor(...fill);
    doc.roundedRect(x, y, w, h, 4, 4, "FD");
  }
  doc.setDrawColor(...color);
  doc.roundedRect(x, y, w, h, 4, 4, "S");
  doc.setFontSize(8.5);
  doc.setTextColor(...INK);
  doc.setFont("helvetica", "bold");
  const lines = doc.splitTextToSize(label, w - 8);
  doc.text(lines, x + w / 2, y + h / 2 + 3 - (lines.length - 1) * 4.5, { align: "center" });
}

function drawLoop(doc: JsPdf, x: number, y: number, w: number) {
  const steps = ["1 Attack", "2 Detect", "3 Fix", "4 Re-test", "5 Report"];
  const n = steps.length;
  const gap = 10;
  const bw = (w - gap * (n - 1)) / n;
  const bh = 34;
  steps.forEach((s, i) => {
    const bx = x + i * (bw + gap);
    box(doc, bx, y, bw, bh, s, i === 2 ? NAVY : [120, 120, 140], i === 2 ? [224, 231, 247] : undefined);
    if (i < n - 1) {
      doc.setDrawColor(150, 150, 165);
      doc.line(bx + bw, y + bh / 2, bx + bw + gap, y + bh / 2);
    }
  });
  doc.setDrawColor(...RED);
  doc.setLineDashPattern([3, 3], 0);
  const fixX = x + 2 * (bw + gap) + bw / 2;
  const reX = x + 3 * (bw + gap) + bw / 2;
  doc.line(reX, y + bh, reX, y + bh + 14);
  doc.line(reX, y + bh + 14, fixX, y + bh + 14);
  doc.line(fixX, y + bh + 14, fixX, y + bh);
  doc.setLineDashPattern([], 0);
  doc.setFontSize(7.5);
  doc.setTextColor(...RED);
  doc.text("re-test fails -> back to fix", (fixX + reX) / 2, y + bh + 24, { align: "center" });
}

function drawTaskFlow(doc: JsPdf, x: number, y: number, w: number, hit: NodeId[], fix: NodeId[]) {
  const hitNames = hit.filter((nn) => nn !== "logs").map(nodeName).join(" -> ");
  const fixNames = fix.map(nodeName).join(", ");
  const bh = 34;
  const bw = (w - 44) / 3;
  box(doc, x, y, bw, bh, "Attack path\n" + hitNames, RED, [250, 235, 235]);
  doc.setDrawColor(150, 150, 165);
  doc.line(x + bw, y + bh / 2, x + bw + 22, y + bh / 2);
  box(doc, x + bw + 22, y, bw, bh, "Detect in\nAI logs", [120, 120, 140]);
  doc.line(x + 2 * bw + 22, y + bh / 2, x + 2 * bw + 44, y + bh / 2);
  box(doc, x + 2 * bw + 44, y, bw, bh, "Fix at\n" + fixNames, GREEN, [230, 243, 236]);
}
