import type { ReactNode } from 'react';
import { inPlatform } from '../platform';

export const PRODUCT = 'ThreatReady Firewall';
export const COMPANY = 'Aerovant Technologies';
export const TAGLINE = `${PRODUCT} by ${COMPANY}: hands-on firewall administration training from first cable to incident containment.`;
export const BADGE_DISCLAIMER = 'Internal badge: progress inside this simulation, not a certification.';

/**
 * Aerovant logo · divider · THREATREADY, plus the page's navigation buttons. Training-layer pages only — never inside
 * the simulated appliance. Inside ThreatReady the platform strip above already carries the ThreatReady mark, so only
 * the buttons are shown. Below 640 px the buttons wrap onto their own full-width row.
 */
export function BrandRow({ right }: { right?: ReactNode }) {
  return (
    <header className={`tr-brandrow${inPlatform ? ' in-platform' : ''}`}>
      {inPlatform ? null : (
        <span className="tr-brandmark" role="img" aria-label="ThreatReady, by Aerovant Technologies">
          <img src={`${import.meta.env.BASE_URL}brand/aerovant-logo-light.svg`} alt="" />
          <span className="div" aria-hidden="true" />
          <span className="word" aria-hidden="true">ThreatReady</span>
        </span>
      )}
      {right ? <nav className="right" aria-label="Training pages">{right}</nav> : null}
    </header>
  );
}

export function BrandFooter({ closing }: { closing?: boolean }) {
  return <footer className="tr-footer">{closing ? `${PRODUCT} · ${COMPANY}` : `© ${new Date().getFullYear()} ${COMPANY} · ThreatReady`}</footer>;
}

/** One colour per level, kept clear of the severity colours (red/orange/amber). */
export const LEVEL_COLOR = ['#7dd3fc', '#3fb6a8', '#818cf8', '#c084fc', '#e2e8f0'];

export function BadgeShield({ level, size = 44, earned = true }: { level: number; size?: number; earned?: boolean }) {
  const c = LEVEL_COLOR[level] ?? '#94a3b8';
  return (
    <svg width={size} height={size * 1.12} viewBox="0 0 40 45" role="img" aria-label={`Level ${level} badge${earned ? '' : ' (not earned)'}`}>
      <path d="M20 2 L37 8 V21 C37 32 29 40 20 43 C11 40 3 32 3 21 V8 Z" fill="#0b1520" stroke={c} strokeWidth="2.5" />
      <path d="M20 7 L32 11.5 V21 C32 29 26.5 35 20 37.5 C13.5 35 8 29 8 21 V11.5 Z" fill={c} opacity=".16" />
      <text x="20" y="27.5" textAnchor="middle" fontFamily="IBM Plex Sans, Segoe UI, Arial" fontWeight="700" fontSize="15" fill={c}>{level}</text>
    </svg>
  );
}
