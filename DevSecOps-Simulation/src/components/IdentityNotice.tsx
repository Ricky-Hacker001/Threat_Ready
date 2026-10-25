import { inPlatform, platformIdentity, waitText } from '../platform';

/**
 * Where progress lives (TR-27), worded like the ThreatReady labs catalog: practice progress kept in this browser (or,
 * when the account could not be confirmed, this tab), never on the ThreatReady profile.
 */
export function progressNote(): string {
  if (platformIdentity().problem) return 'Progress is kept in this tab only this time.';
  return inPlatform ? 'Progress is kept in this browser and is not recorded on your ThreatReady profile.' : 'Progress is kept in this browser.';
}

/**
 * Inside ThreatReady when the signed-in account could not be confirmed: progress is kept in this tab only (never
 * under a key another learner on this browser could read or inherit), and we say so, with when to try again.
 */
export function IdentityNotice() {
  const { problem, retryAfter } = platformIdentity();
  if (!problem) return null;
  return (
    <div className="idnote" role="status">
      <p>
        <b>Progress won&apos;t be saved this time.</b>{' '}
        {problem === 'signed-out' ? 'Your ThreatReady sign-in could not be confirmed (it may have expired).' : "We couldn't reach ThreatReady to confirm who is signed in."}{' '}
        You can keep practising, but your work stays in this tab only and is gone when you close or reload it.{' '}
        {problem === 'signed-out' ? 'Reload to sign in again.' : retryAfter ? `Reload in about ${waitText(retryAfter)} to try again.` : 'Reload to try again.'}
      </p>
      <button type="button" className="btn sm" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
