import type { InterviewReport } from '@threatready/contracts';
import PDFDocument from 'pdfkit';

const INK = '#16181d';
const MUTED = '#5b6270';
const ACCENT = '#c8283c';

/** Renders the saved report as a PDF. Runs in the worker only; text is drawn, never interpreted. */
export function renderReportPdf(r: InterviewReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `ThreatReady interview report — ${r.roleTitle}`, Author: 'ThreatReady' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fillColor(ACCENT).fontSize(10).text('THREATREADY · INTERVIEWPREP');
    doc.moveDown(0.3).fillColor(INK).fontSize(20).text(`Interview report: ${r.roleTitle}`);
    doc
      .fontSize(10)
      .fillColor(MUTED)
      .text(`${r.config.interviewType.replace(/_/g, ' ')} · ${r.config.difficulty} · ${r.config.durationMin} minutes · ${new Date(r.generatedAt).toUTCString()}`);
    doc.moveDown().fontSize(9).text(r.disclaimer);

    doc.moveDown().fillColor(INK).fontSize(14).text(`Overall score: ${r.overall.score} / 100`);
    const cat = (label: string, v: number | null) => `${label}: ${v === null ? 'not assessed' : `${v}/100`}`;
    doc
      .fontSize(10)
      .text([cat('Technical knowledge', r.overall.technicalKnowledge), cat('Problem solving', r.overall.problemSolving), cat('Communication', r.overall.communication), cat('Role skill coverage', r.overall.roleSkillCoverage)].join('   '));
    doc.moveDown(0.5).text(r.overall.summary);

    section(doc, 'Skills');
    line(doc, 'Demonstrated', r.skills.demonstrated.map((s) => `${s.label} (${s.score})`).join(', ') || 'None yet');
    line(doc, 'Needs improvement', r.skills.needsImprovement.map((s) => `${s.label} (${s.score})`).join(', ') || 'None');
    line(doc, 'Gaps against the job description', r.skills.jdGaps.map((s) => s.label).join(', ') || 'None');

    section(doc, 'Improvement plan');
    for (const t of r.improvementPlan.highPriority) line(doc, `High priority — ${t.topic}`, t.why);
    for (const t of r.improvementPlan.secondary) line(doc, t.topic, t.why);
    if (r.improvementPlan.practiceQuestions.length) {
      doc.moveDown(0.3).fontSize(10).fillColor(INK).text('Practice questions:');
      for (const q of r.improvementPlan.practiceQuestions) doc.fillColor(MUTED).text(`• ${q}`);
    }

    section(doc, 'Question review');
    for (const q of r.questions) {
      doc
        .moveDown(0.6)
        .fillColor(INK)
        .fontSize(11)
        .text(`Q${q.questionNumber}${q.kind === 'follow_up' ? ' (follow-up)' : ''} · ${q.topic}${q.score === null ? '' : ` · ${q.score}/100`}`);
      doc.fontSize(10).fillColor(INK).text(q.question);
      doc.fillColor(MUTED).text(`Your answer: ${q.answer ?? '(not answered)'}`);
      if (q.explanation) doc.text(`Assessment: ${q.explanation}`);
      if (q.missingConcepts.length) doc.text(`Missing: ${q.missingConcepts.join(', ')}`);
      if (q.improvements.length) doc.text(`Improve: ${q.improvements.join(' ')}`);
      if (q.strongAnswerExample) doc.text(`Strong answer example: ${q.strongAnswerExample}`);
    }

    section(doc, 'How this was scored');
    for (const n of r.scoringMethod.notes) doc.fontSize(9).fillColor(MUTED).text(`• ${n}`);
    doc.end();
  });
}

function section(doc: PDFKit.PDFDocument, title: string) {
  doc.moveDown(1).fillColor(ACCENT).fontSize(13).text(title);
}

function line(doc: PDFKit.PDFDocument, label: string, value: string) {
  doc.moveDown(0.2).fontSize(10).fillColor(INK).text(`${label}: `, { continued: true }).fillColor(MUTED).text(value);
}
