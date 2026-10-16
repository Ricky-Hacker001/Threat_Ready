export function Brand({ onClick }: { onClick?: () => void }) {
  return (
    <div className="brand" onClick={onClick}>
      <img src={`${import.meta.env.BASE_URL}logo-sm.png`} alt="" width="26" height="25" />
      <span>
        ThreatReady <span style={{ color: 'var(--dim)', fontWeight: 400 }}>|</span> DevSecOps Lab <small>· AeroShop simulation</small>
      </span>
    </div>
  );
}
