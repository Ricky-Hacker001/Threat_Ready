import type { SessionState } from '@threatready/contracts';

export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const STATE_LABEL: Record<SessionState, { label: string; tone: 'ok' | 'warn' | 'accent' | 'info' | '' }> = {
  parsing: { label: 'Analysing documents', tone: 'info' },
  profiled: { label: 'Ready to configure', tone: 'warn' },
  planned: { label: 'Ready to start', tone: 'warn' },
  asking: { label: 'In progress', tone: 'accent' },
  awaiting_answer: { label: 'In progress', tone: 'accent' },
  evaluating: { label: 'In progress', tone: 'accent' },
  paused: { label: 'Paused', tone: 'warn' },
  completed: { label: 'Scoring', tone: 'info' },
  scoring: { label: 'Generating report', tone: 'info' },
  report_ready: { label: 'Report ready', tone: 'ok' },
  failed: { label: 'Failed', tone: 'accent' },
  expired: { label: 'Expired', tone: '' },
  cancelled: { label: 'Cancelled', tone: '' },
};

export const scoreTone = (score: number | null | undefined) => (score == null ? '' : score >= 70 ? 'ok' : score >= 50 ? 'warn' : 'accent');
