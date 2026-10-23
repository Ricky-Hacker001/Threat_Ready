import { DomainError } from '@threatready/shared';

/**
 * Keyset pagination cursors: a base64url ISO timestamp. A malformed cursor is a validation error,
 * never a RangeError from `new Date(garbage)` deep in a query (500, audit 2026-10-15 §5).
 */
export function cursorBefore(cursor: string | undefined | null): Date | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  const invalid = () => new DomainError('VALIDATION_FAILED', { details: [{ path: 'cursor', message: 'invalid cursor' }] });
  if (typeof cursor !== 'string' || cursor.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(decoded)) throw invalid();
  const date = new Date(decoded);
  if (Number.isNaN(date.getTime())) throw invalid();
  return date;
}

export function cursorOf(createdAt: Date | string): string {
  return Buffer.from(typeof createdAt === 'string' ? createdAt : createdAt.toISOString()).toString('base64url');
}
