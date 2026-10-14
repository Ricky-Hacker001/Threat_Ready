/**
 * The interview clock runs only while the candidate is answering (state awaiting_answer). Model
 * latency and pauses never consume the candidate's time.
 */
export interface ClockState {
  activeElapsedMs: number;
  runningSince: Date | null;
}

export function elapsedMs(s: ClockState, now: Date = new Date()): number {
  return s.activeElapsedMs + (s.runningSince ? Math.max(0, now.getTime() - s.runningSince.getTime()) : 0);
}

export function remainingSec(s: ClockState, durationMin: number, now: Date = new Date()): number {
  return Math.max(0, Math.round(durationMin * 60 - elapsedMs(s, now) / 1000));
}

/** Stop the clock, folding the running interval into the accumulated total. */
export function stopClock(s: ClockState, now: Date = new Date()): ClockState {
  return { activeElapsedMs: elapsedMs(s, now), runningSince: null };
}

export function startClock(s: ClockState, now: Date = new Date()): ClockState {
  return { activeElapsedMs: s.activeElapsedMs, runningSince: s.runningSince ?? now };
}

export const IDLE_PAUSE_MS = 10 * 60 * 1000;
