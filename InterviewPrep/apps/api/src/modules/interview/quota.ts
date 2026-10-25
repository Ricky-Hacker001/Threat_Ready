import { interviewSessions } from '@threatready/db';
import { sql } from 'drizzle-orm';

/**
 * A session uses monthly quota unless it delivered nothing the AI was paid for: the candidate
 * cancelled it before its analysis finished, or the analysis failed (for example, the AI provider was
 * unavailable). A session cancelled after its analysis completed counts: otherwise create, analyse,
 * cancel could run the analysis calls without limit (audit 2026-10-23 TR-08, IP-06).
 */
export const countsTowardQuota = sql`NOT ((${interviewSessions.state} = 'cancelled' AND ${interviewSessions.analysis} IS NULL) OR (${interviewSessions.state} = 'failed' AND ${interviewSessions.failureStage} = 'analysis'))`;
