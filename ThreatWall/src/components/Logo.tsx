/** ThreatWall shield: a shield outline with brick courses and an orange strike line. Original mark. */
export function ShieldMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 2.5 4.5 6.6v8.6c0 7.3 4.9 12.4 11.5 14.3 6.6-1.9 11.5-7 11.5-14.3V6.6L16 2.5Z" fill="#1b2129" stroke="#e9eef4" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 11.2h16M8 16h16M9.4 20.8h13.2M13 11.2v4.8M19 16v4.8M16 20.8v4" stroke="#e9eef4" strokeWidth="1.3" strokeLinecap="round" opacity=".85" />
      <path d="M6.5 23.5 25.8 7.8" stroke="#ef6c1f" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span className="tw-brand-name" style={{ fontSize: size }}>
      Threat<b>Wall</b>
    </span>
  );
}
