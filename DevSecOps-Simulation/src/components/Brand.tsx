import { inPlatform } from '../platform';

/** Served under /labs/ means inside ThreatReady, where the platform strip above carries the mark. */
export function Brand({ onClick }: { onClick?: () => void }) {
  return (
    <a
      className="brand"
      href="#/"
      onClick={(e) => {
        if (!onClick) return;
        e.preventDefault();
        onClick();
      }}
    >
      {!inPlatform && <img src={`${import.meta.env.BASE_URL}logo-sm.png`} alt="" width="26" height="25" />}
      <span>
        {!inPlatform && (
          <>
            ThreatReady <span style={{ color: 'var(--dim)', fontWeight: 400 }}>|</span>{' '}
          </>
        )}
        DevSecOps Lab <small>· AeroShop simulation</small>
      </span>
    </a>
  );
}
