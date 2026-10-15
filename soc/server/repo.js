// Repository: the only module routes use to read or write attempts and
// awards (internal level badges). Cases stay in store.js. Swapping JSON
// files for a database changes this module and store.js only.

import crypto from 'node:crypto';
import path from 'node:path';
import { JsonFile, DATA_DIR, store } from './store.js';

const attemptsFile = new JsonFile(path.join(DATA_DIR, 'attempts.json'), () => ({ attempts: {} }));
const awardsFile = new JsonFile(path.join(DATA_DIR, 'awards.json'), () => ({ badges: {} }));

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newId(prefix, n = 8) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (const b of bytes) s += CROCK[b % 32];
  return `${prefix}_${s}`;
}

const wipeListeners = [];
export const onWipe = (fn) => wipeListeners.push(fn);

export const repo = {
  createAttempt(rec) {
    attemptsFile.db.attempts[rec.attemptId] = rec;
    attemptsFile.save();
    return rec;
  },
  getAttempt(id) { return attemptsFile.db.attempts[id] || null; },
  updateAttempt(id, patch) {
    const a = attemptsFile.db.attempts[id];
    if (!a) return null;
    Object.assign(a, patch);
    attemptsFile.save();
    return a;
  },
  touchAttempt() { attemptsFile.save(); },
  listAttempts(userId) {
    return Object.values(attemptsFile.db.attempts).filter((a) => a.userId === userId).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.attemptId.localeCompare(a.attemptId));
  },
  allAttempts() { return Object.values(attemptsFile.db.attempts); },
  listAwards(userId) {
    return Object.values(awardsFile.db.badges).filter((b) => b.userId === userId).sort((a, b) => a.earnedAt.localeCompare(b.earnedAt));
  },
  addAward(badge) {
    awardsFile.db.badges[badge.badgeId] = badge;
    awardsFile.save();
    return badge;
  },
  // Daily wipe: cases, attempts and badges all go.
  wipeAll() {
    for (const c of store.all()) store.remove(c.id);
    store.reset();
    attemptsFile.reset();
    awardsFile.reset();
    for (const fn of wipeListeners) fn();
  },
  flush() { attemptsFile.flushNow(); awardsFile.flushNow(); store.flushNow(); },
};
