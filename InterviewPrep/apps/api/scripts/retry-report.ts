/**
 * Operator tool: re-queues report generation for a session whose scoring failed, exactly as the
 * candidate's "Generate report again" button does. Usage: tsx scripts/retry-report.ts <sessionId>
 */
import { NestFactory } from '@nestjs/core';
import { interviewSessions } from '@threatready/db';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { InterviewService } from '../src/modules/interview/interview.service.js';
import { Database } from '../src/platform/db/database.js';

const sessionId = process.argv[2];
if (!sessionId) throw new Error('usage: retry-report.ts <sessionId>');
const cfg = loadConfig();
const ctx = await NestFactory.createApplicationContext(AppModule.forRole('api', cfg), { logger: ['error', 'warn'] });
const db = ctx.get(Database);
const [s] = await db.system(({ db: d }) => d.select().from(interviewSessions).where(eq(interviewSessions.id, sessionId)));
if (!s) throw new Error('session not found');
const view = await ctx.get(InterviewService).retryReport(
  { userId: s.userId, orgId: s.orgId, sessionId: 'operator', role: 'learner', isStaff: false, email: '', name: '' },
  sessionId,
);
console.log(`session ${sessionId}: ${view.state}`);
await ctx.close();
