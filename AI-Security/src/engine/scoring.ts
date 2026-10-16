/** Scoring engine. Weights and deductions exactly per the design document. */
import type { Level, ScoreBreakdown } from "./types";

const WEIGHTS: Record<
  Level,
  {
    attack: number;
    evidence: number;
    detection: number;
    fix: number;
    retest: number;
    benign: number;
    report: number;
  }
> = {
  foundation: { attack: 20, evidence: 20, detection: 0, fix: 30, retest: 20, benign: 10, report: 0 },
  intermediate: { attack: 15, evidence: 20, detection: 15, fix: 25, retest: 15, benign: 10, report: 0 },
  expert: { attack: 15, evidence: 15, detection: 15, fix: 20, retest: 15, benign: 10, report: 10 },
};

export const PASS_MARK = 70;

export interface ScoreInputs {
  level: Level;
  attackSucceeded: boolean;
  evidenceFraction: number; // 0..1
  detectionOk: boolean; // only used when weight>0
  fixFraction: number; // 0..1 of required controls satisfied
  retestPassed: boolean;
  overBlockCount: number;
  reportFraction: number; // 0..1 expert report quality
  hintsUsed: number;
  wrongLayerApplied: number;
  failedRetestsAfterSecond: number;
}

function round(n: number): number {
  return Math.round(n);
}

export function scoreAttempt(inp: ScoreInputs): ScoreBreakdown {
  const w = WEIGHTS[inp.level];
  const lines: string[] = [];

  const attackSucceeded = inp.attackSucceeded ? w.attack : 0;
  lines.push(
    inp.attackSucceeded
      ? `+${attackSucceeded}  Attack executed and understood.`
      : `+0  Attack not executed — you must reproduce the issue first.`,
  );

  const evidence = round(w.evidence * inp.evidenceFraction);
  lines.push(
    `+${evidence}  Evidence marked (${Math.round(inp.evidenceFraction * 100)}% of the accepted set).`,
  );

  let detection = 0;
  if (w.detection > 0) {
    detection = inp.detectionOk ? w.detection : 0;
    lines.push(
      inp.detectionOk
        ? `+${detection}  Detection rule catches the attack without excessive noise.`
        : `+0  Detection rule missing or ineffective.`,
    );
  }

  const fix = round(w.fix * inp.fixFraction);
  lines.push(
    `+${fix}  Fix at the correct layer (${Math.round(inp.fixFraction * 100)}% of required controls).`,
  );

  const retest = inp.retestPassed ? w.retest : 0;
  lines.push(
    inp.retestPassed
      ? `+${retest}  Re-test passed: attacks blocked, legitimate traffic intact.`
      : `+0  Re-test not passed.`,
  );

  const benign = inp.overBlockCount === 0 ? w.benign : 0;
  lines.push(
    inp.overBlockCount === 0
      ? `+${benign}  No over-blocking — real customers unaffected.`
      : `+0  ${inp.overBlockCount} legitimate request(s) blocked.`,
  );

  let report = 0;
  if (w.report > 0) {
    report = round(w.report * inp.reportFraction);
    lines.push(`+${report}  Expert report quality (${Math.round(inp.reportFraction * 100)}%).`);
  }

  // Deductions
  let deductions = 0;
  if (inp.level === "intermediate" && inp.hintsUsed > 0) {
    const d = inp.hintsUsed * 5;
    deductions += d;
    lines.push(`−${d}  ${inp.hintsUsed} hint(s) used.`);
  }
  if (inp.wrongLayerApplied > 0) {
    const d = inp.wrongLayerApplied * 10;
    deductions += d;
    lines.push(`−${d}  ${inp.wrongLayerApplied} wrong-layer fix(es) applied.`);
  }
  if (inp.overBlockCount > 0) {
    const d = inp.overBlockCount * 5;
    deductions += d;
    lines.push(`−${d}  ${inp.overBlockCount} over-blocked legitimate request(s).`);
  }
  if (inp.failedRetestsAfterSecond > 0) {
    const d = inp.failedRetestsAfterSecond * 5;
    deductions += d;
    lines.push(`−${d}  ${inp.failedRetestsAfterSecond} failed re-test(s) after the second retry.`);
  }

  const gross = attackSucceeded + evidence + detection + fix + retest + benign + report;
  const total = Math.max(0, Math.min(100, gross - deductions));
  const passed = total >= PASS_MARK;

  return {
    attackSucceeded,
    evidence,
    detectionRule: detection,
    fixCorrectLayer: fix,
    retestPass: retest,
    benignWorks: benign,
    expertReport: report,
    deductions,
    total,
    passed,
    lines,
  };
}
