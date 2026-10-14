import type { FallbackReason, InterviewerStatus } from './InterviewerStage';
import { InterviewerPortrait } from './InterviewerPortrait';
import { StatusPill } from './StatusPill';
import './avatar.css';

/** Shown only when something went wrong mid-session; a server without the 3D model is normal. */
const REASON_TEXT: Partial<Record<FallbackReason, string>> = {
  'context-lost': 'The 3D view was interrupted by the graphics driver, so Alex switched to 2D.',
};

export interface AvatarFallbackProps {
  status: InterviewerStatus;
  speaking?: boolean;
  candidateTyping?: boolean;
  reason?: FallbackReason;
  className?: string;
}

/**
 * The 2D interviewer: Alex as an illustrated portrait with lip sync, blinking and listening
 * motion. Used when WebGL or the licensed 3D model is unavailable; works in every browser.
 */
export function AvatarFallback({ status, speaking = false, candidateTyping = false, reason, className }: AvatarFallbackProps) {
  const note = reason ? REASON_TEXT[reason] : undefined;
  return (
    <div className={['ivw-stage', 'ivw-fallback', className].filter(Boolean).join(' ')} data-status={status} data-speaking={speaking || undefined}>
      <div className="ivw-fallback-art">
        <InterviewerPortrait status={status} speaking={speaking} candidateTyping={candidateTyping} />
      </div>
      <div className="ivw-hud">
        <span className="ivw-name">Alex · Interviewer</span>
        <StatusPill status={status} speaking={speaking} />
      </div>
      {note ? <p className="ivw-fallback-note">{note}</p> : null}
    </div>
  );
}

export default AvatarFallback;
