/**
 * Admin feed adapter. Builds the structured attempt summary for the ThreatReady
 * admin portal. No real portal endpoint is bundled — this is a clean adapter with
 * a local sink; configure a real transport later.
 */
import type { AttemptState, ScoreBreakdown } from "./types";

export interface AdminFeedPayload {
  learnerName: string;
  scenarioId: string;
  level: string;
  scoreTotal: number;
  scoreBreakdown: Omit<ScoreBreakdown, "lines">;
  passed: boolean;
  timeTakenSec: number;
  hintsUsed: number;
  wrongLayerCount: number;
  timestamp: string;
}

export function buildAdminPayload(
  learnerName: string,
  state: AttemptState,
  score: ScoreBreakdown,
): AdminFeedPayload {
  const { lines: _lines, ...breakdown } = score;
  void _lines;
  return {
    learnerName,
    scenarioId: state.scenarioId,
    level: state.level,
    scoreTotal: score.total,
    scoreBreakdown: breakdown,
    passed: score.passed,
    timeTakenSec: Math.round((Date.now() - state.startedAt) / 1000),
    hintsUsed: state.hintsUsed,
    wrongLayerCount: state.wrongLayerApplied,
    timestamp: new Date().toISOString(),
  };
}

export interface AdminFeedSink {
  send(payload: AdminFeedPayload): Promise<void>;
}

/** Default local sink: records payloads in memory (and logs in dev). */
export class LocalAdminFeedSink implements AdminFeedSink {
  public readonly sent: AdminFeedPayload[] = [];
  async send(payload: AdminFeedPayload): Promise<void> {
    this.sent.push(payload);
  }
}
