// One analyst's progress in a few numbers, for the ThreatReady profile and admin console.
// threatready-lab-001 (server/hosted.ts socSummary) folds it into the labs summary in process;
// GET /internal/v1/users/:uid/summary serves the same numbers when SOC_INTERNAL_TOKEN is set.

import { repo } from './repo.js';
import { LEVELS } from './levels.js';
import { getScenario } from './scenarios/index.js';

const STATUS = { open: 'In progress', closed: null, abandoned: 'Abandoned' };

export function userSummary(uid) {
  const attempts = repo.listAttempts(uid); // newest first
  const badges = repo.listAwards(uid);
  const closed = attempts.filter((a) => a.status === 'closed');
  const worked = attempts.filter((a) => a.status !== 'abandoned');
  return {
    app: 'soc',
    attempts: attempts.length,
    abandoned: attempts.length - worked.length,
    open: attempts.filter((a) => a.status === 'open').length,
    closed: closed.length,
    scenariosPassed: new Set(closed.filter((a) => a.passed).map((a) => a.scenarioId)).size,
    badges: badges.length,
    levels: LEVELS.length,
    // Complete: every level's internal badge earned.
    complete: LEVELS.every((l) => badges.some((b) => b.level === l.id)),
    best: closed.length ? Math.max(...closed.map((a) => a.score ?? 0)) : null,
    lastAt: attempts[0] ? (attempts[0].closedAt || attempts[0].startedAt) : null,
    items: worked.slice(0, 10).map((a) => {
      const s = getScenario(a.scenarioId);
      return {
        attemptId: a.attemptId, caseId: a.caseId, code: s?.code || a.scenarioId, title: s?.catalog.title || a.scenarioId, level: a.level,
        status: STATUS[a.status] ?? (a.passed ? 'Passed' : 'Not passed'),
        score: a.status === 'closed' ? a.score : null,
        at: a.closedAt || a.startedAt,
      };
    }),
  };
}
