import type { ClipName } from './avatarContract';
import type { InterviewerStatus } from './InterviewerStage';

/** After this long without candidate typing, a listening interviewer settles into Idle. */
export const LISTEN_IDLE_AFTER_S = 8;

/** Pure status -> clip mapping (exported for tests). */
export function clipForStatus(status: InterviewerStatus, opts: { quietFor?: number; reducedMotion?: boolean } = {}): ClipName {
  if (opts.reducedMotion) return 'Idle';
  switch (status) {
    case 'asking':
      return 'Talk';
    case 'evaluating':
      return 'Think';
    case 'preparing':
      return 'Listen';
    case 'listening':
      return (opts.quietFor ?? 0) > LISTEN_IDLE_AFTER_S ? 'Idle' : 'Listen';
    case 'paused':
    case 'finished':
    default:
      return 'Idle';
  }
}
