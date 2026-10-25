/**
 * Operator tool: re-queues report generation for a session whose scoring failed, exactly as the
 * candidate's "Generate report again" button does. `--reset` first clears the retry count, for the
 * "contact support" case after the learner used every attempt (REPORT_RETRY_LIMIT_REACHED). When final
 * scoring stopped at its per-session ceiling (AI_FINALIZE_SOURCE_CAP_USD), `--reset` also raises that
 * session's ceiling by one more cap, or by `--allow-usd=N`: the new attempt may bill that much again.
 * Usage: tsx scripts/retry-report.ts <sessionId> [--reset [--allow-usd=N]]
 */
import { NestFactory } from '@nestjs/core';
import { interviewSessions } from '@threatready/db';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { InterviewService } from '../src/modules/interview/interview.service.js';
import { Database } from '../src/platform/db/database.js';

const sessionId = process.argv.slice(2).find((a) => !a.startsWith('--'));
const reset = process.argv.includes('--reset');
const allowArg = process.argv.find((a) => a.startsWith('--allow-usd='));
const allowUsd = allowArg === undefined ? undefined : Number(allowArg.slice('--allow-usd='.length));
if (!sessionId) throw new Error('usage: retry-report.ts <sessionId> [--reset [--allow-usd=N]]');
if (allowUsd !== undefined && !(Number.isFinite(allowUsd) && allowUsd >= 0)) throw new Error('--allow-usd must be a number of dollars, 0 or more');
const cfg = loadConfig();
const ctx = await NestFactory.createApplicationContext(AppModule.forRole('api', cfg), { logger: ['error', 'warn'] });
const db = ctx.get(Database);
const interviews = ctx.get(InterviewService);
const [s] = await db.system(({ db: d }) => d.select().from(interviewSessions).where(eq(interviewSessions.id, sessionId)));
if (!s) throw new Error('session not found');
if (reset) {
  const { extraSourceCapUsd } = await interviews.resetReportRetries(sessionId, allowUsd);
  console.log(`session ${sessionId}: retry count reset`);
  if (extraSourceCapUsd > 0) console.log(`session ${sessionId}: final scoring may spend $${extraSourceCapUsd.toFixed(2)} over AI_FINALIZE_SOURCE_CAP_USD`);
}
const view = await interviews.retryReport(
  { userId: s.userId, orgId: s.orgId, sessionId: 'operator', role: 'learner', isStaff: false, email: '', name: '' },
  sessionId,
);
console.log(`session ${sessionId}: ${view.state}`);
await ctx.close();
