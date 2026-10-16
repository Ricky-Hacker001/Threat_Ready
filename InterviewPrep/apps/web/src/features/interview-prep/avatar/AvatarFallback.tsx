import type { FallbackReason, InterviewerStatus } from './InterviewerStage';
import { InterviewerPhoto, usePhotoSet } from './InterviewerPhoto';
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
 * The 2D interviewer, used when WebGL or the licensed 3D model is unavailable (every browser):
 * photographs of Alex (stills of the 3D model) with lip sync, blinks and head turns when they are
 * deployed, otherwise the illustrated portrait. The illustration also covers the moment the photos
 * are still loading, so something is always on screen.
 */
export function AvatarFallback({ status, speaking = false, candidateTyping = false, reason, className }: AvatarFallbackProps) {
  const note = reason ? REASON_TEXT[reason] : undefined;
  const photos = usePhotoSet();
  return (
    <div className={['ivw-stage', 'ivw-fallback', className].filter(Boolean).join(' ')} data-status={status} data-speaking={speaking || undefined} data-art={photos ? 'photo' : 'portrait'}>
      <div className="ivw-fallback-art">
        {photos
          ? <InterviewerPhoto photos={photos} status={status} speaking={speaking} candidateTyping={candidateTyping} />
          : <InterviewerPortrait status={status} speaking={speaking} candidateTyping={candidateTyping} />}
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
