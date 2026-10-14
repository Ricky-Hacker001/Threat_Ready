import type { InterviewerStatus } from './InterviewerStage';

export const STATUS_LABEL: Record<InterviewerStatus, string> = {
  preparing: 'Preparing',
  asking: 'Asking',
  listening: 'Listening',
  evaluating: 'Evaluating',
  paused: 'Paused',
  finished: 'Finished',
};

/** Interviewer status chip. It is the stage's polite live region, so changes are announced. */
export function StatusPill({ status, speaking }: { status: InterviewerStatus; speaking: boolean }) {
  return (
    <div className="ivw-pill" data-status={status}>
      <span className="ivw-dot" aria-hidden="true" />
      <span role="status" aria-live="polite" aria-atomic="true">
        {STATUS_LABEL[status]}
      </span>
      {speaking && (
        <span className="ivw-wave" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  );
}
