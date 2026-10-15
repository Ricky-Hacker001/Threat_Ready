// Internal level badges: shield artwork and the badge-earned dialog.
// Badges show progress inside this simulation only. There is no certificate.

import React, { useEffect, useRef } from 'react';

const TONE = {
  foundations: { a: '#2f6f4f', b: '#4fa37a', mark: 'F' },
  intermediate: { a: '#24508c', b: '#4a86d0', mark: 'I' },
  expert: { a: '#6a2f86', b: '#9a5cc0', mark: 'E' },
};

export function Shield({ level, earned = true, size = 72, title }) {
  const t = TONE[level] || TONE.foundations;
  const id = `sh-${level}-${earned ? 'on' : 'off'}`;
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 100 115" role="img" aria-label={title || `${level} badge${earned ? '' : ' (not yet earned)'}`} className={`shield${earned ? '' : ' shield-off'}`}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={earned ? t.b : '#c9ced6'} />
          <stop offset="1" stopColor={earned ? t.a : '#9aa1ab'} />
        </linearGradient>
      </defs>
      <path d="M50 4 L92 18 V54 C92 82 72 100 50 111 C28 100 8 82 8 54 V18 Z" fill={`url(#${id})`} stroke={earned ? t.a : '#8a919b'} strokeWidth="3" />
      <path d="M50 14 L83 25 V54 C83 76 67 91 50 100 C33 91 17 76 17 54 V25 Z" fill="none" stroke="rgba(255,255,255,.55)" strokeWidth="2" />
      <text x="50" y="68" textAnchor="middle" fontSize="38" fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">{t.mark}</text>
    </svg>
  );
}

// Shown once when a submission earns a level badge.
export function BadgeDialog({ badge, onClose, go }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  if (!badge) return null;
  const all = badge.allComplete;
  return (
    <div className="modal-back" role="presentation" onClick={onClose}>
      <div className="modal badge-modal" role="dialog" aria-modal="true" aria-labelledby="badge-h" tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <Shield level={badge.level} size={88} />
        <h2 id="badge-h">{badge.levelName} badge earned</h2>
        {all
          ? <p className="lead-sm">All three SOC Simulation levels completed. Your internal Expert badge has been earned.</p>
          : <p className="lead-sm">You have completed the {badge.levelName} level.</p>}
        <p>{badge.passedCount} of 12 scenarios passed, average {badge.average}.</p>
        {badge.nextLevel && <p><strong>{badge.nextLevel.name} is now open.</strong></p>}
        <p className="muted small">Internal badge: progress inside this simulation, not a certification.</p>
        <div className="modal-actions">
          {badge.nextLevel && <button type="button" className="btn btn-primary" onClick={() => { onClose(); go(`#/level/${badge.nextLevel.id}`); }}>Open {badge.nextLevel.name}</button>}
          <button type="button" className={`btn${badge.nextLevel ? '' : ' btn-primary'}`} onClick={() => { onClose(); go('#/badges'); }}>View badges</button>
          {all && <button type="button" className="btn" onClick={() => { onClose(); go('#/report'); }}>Final analyst report</button>}
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
