import { interviewSessions } from '@threatready/db';
import { sql } from 'drizzle-orm';

/**
 * A session uses monthly quota unless the candidate cancelled it before starting or its analysis
 * failed (for example, the AI provider was unavailable): neither delivered an interview.
 */
export const countsTowardQuota = sql`NOT (${interviewSessions.state} = 'cancelled' OR (${interviewSessions.state} = 'failed' AND ${interviewSessions.failureStage} = 'analysis'))`;
