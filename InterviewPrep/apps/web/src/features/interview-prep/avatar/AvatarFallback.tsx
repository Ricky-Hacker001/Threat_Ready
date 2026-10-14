import { useId } from 'react';
import type { FallbackReason, InterviewerStatus } from './InterviewerStage';
import { StatusPill } from './StatusPill';
import './avatar.css';

const REASON_TEXT: Record<FallbackReason, string> = {
  'no-webgl': '3D view isn’t available in this browser.',
  'asset-error': 'The 3D interviewer couldn’t be loaded.',
  'context-lost': 'The 3D view was interrupted by the graphics driver.',
};

export interface AvatarFallbackProps {
  status: InterviewerStatus;
  speaking?: boolean;
  reason?: FallbackReason;
  className?: string;
}

/**
 * Accessible 2D stand-in for the 3D interviewer: a calm illustrated silhouette, the live status
 * and a clear note that the interview is fully usable in text mode.
 */
export function AvatarFallback({ status, speaking = false, reason = 'no-webgl', className }: AvatarFallbackProps) {
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <div className={['ivw-stage', 'ivw-fallback', className].filter(Boolean).join(' ')} data-status={status} data-speaking={speaking || undefined}>
      <div className="ivw-fallback-art" aria-hidden="true">
        <svg viewBox="0 0 320 220" preserveAspectRatio="xMidYMax meet" role="presentation" focusable="false">
          <defs>
            <radialGradient id={`${gid}-halo`} cx="50%" cy="42%" r="55%">
              <stop offset="0" style={{ stopColor: 'var(--accent)', stopOpacity: 0.16 }} />
              <stop offset="0.55" style={{ stopColor: 'var(--accent)', stopOpacity: 0.04 }} />
              <stop offset="1" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
            </radialGradient>
            <linearGradient id={`${gid}-coat`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#2f353f" />
              <stop offset="1" stopColor="#1b1f26" />
            </linearGradient>
            <linearGradient id={`${gid}-head`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#4a515d" />
              <stop offset="1" stopColor="#2c323c" />
            </linearGradient>
            <linearGradient id={`${gid}-desk`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#262b33" />
              <stop offset="1" stopColor="#15181d" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="320" height="220" fill={`url(#${gid}-halo)`} />
          <g className="ivw-figure">
            {/* shoulders & blazer */}
            <path d="M62 222 C64 178 92 156 132 150 L160 147 L188 150 C228 156 256 178 258 222 Z" fill={`url(#${gid}-coat)`} />
            {/* shirt */}
            <path d="M140 149 L160 200 L180 149 L170 146 L150 146 Z" fill="#c9ced6" />
            {/* tie (restrained brand accent) */}
            <path d="M156 152 L164 152 L166 160 L162 196 L158 196 L154 160 Z" fill="#7d252c" />
            {/* lapels */}
            <path d="M140 149 L124 154 L146 186 L160 202 Z" fill="#3a404b" />
            <path d="M180 149 L196 154 L174 186 L160 202 Z" fill="#3a404b" />
            {/* neck */}
            <path d="M146 122 L174 122 L176 150 L160 156 L144 150 Z" fill="#3a404b" />
            {/* head */}
            <ellipse cx="160" cy="98" rx="31" ry="37" fill={`url(#${gid}-head)`} />
            {/* hair */}
            <path d="M129 96 C127 70 143 58 162 58 C182 58 194 70 192 94 C186 80 176 74 160 75 C146 76 135 82 129 96 Z" fill="#1c2026" />
            {/* ears */}
            <ellipse cx="129" cy="101" rx="4" ry="8" fill="#353b46" />
            <ellipse cx="191" cy="101" rx="4" ry="8" fill="#353b46" />
          </g>
          {/* desk */}
          <rect x="20" y="196" width="280" height="24" rx="3" fill={`url(#${gid}-desk)`} />
          <rect x="20" y="196" width="280" height="1.5" fill="#3a404b" />
        </svg>
      </div>
      <div className="ivw-fallback-copy">
        <StatusPill status={status} speaking={speaking} />
        <p className="ivw-fallback-title">Text mode</p>
        <p className="ivw-fallback-note">
          {REASON_TEXT[reason]} The interview works fully in text mode — questions, answers and feedback are all
          available on this page.
        </p>
      </div>
    </div>
  );
}

export default AvatarFallback;
