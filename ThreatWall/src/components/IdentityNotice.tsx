import { Info } from 'lucide-react';
import { platformIdentity, waitText } from '../platform';

/**
 * Inside ThreatReady when the signed-in account could not be confirmed: progress is kept in this tab only (never
 * under a key another learner on this browser could read or inherit), and we say so, with when to try again.
 * `page` is the training-layer card (home); `stage` is the bar above the simulated appliance.
 */
export function IdentityNotice({ variant }: { variant: 'page' | 'stage' }) {
  const { problem, retryAfter } = platformIdentity();
  if (!problem) return null;
  const text = (
    <p>
      <b>Progress won't be saved this time.</b>{' '}
      {problem === 'signed-out' ? 'Your ThreatReady sign-in could not be confirmed (it may have expired).' : "We couldn't reach ThreatReady to confirm who is signed in."}{' '}
      You can keep practising, but the lab stays in this tab only and is gone when you close or reload it.{' '}
      {problem === 'signed-out' ? 'Reload to sign in again.' : retryAfter ? `Reload in about ${waitText(retryAfter)} to try again.` : 'Reload to try again.'}
    </p>
  );
  const reload = () => window.location.reload();
  if (variant === 'page') {
    return (
      <div className="tr-card tr-notice tr-noprint" role="status">
        <Info size={18} aria-hidden="true" />
        {text}
        <button type="button" className="tr-btn" onClick={reload}>Reload</button>
      </div>
    );
  }
  return (
    <div className="tw-id-notice" role="status">
      <Info size={15} aria-hidden="true" />
      {text}
      <button type="button" onClick={reload}>Reload</button>
    </div>
  );
}
