import { useEffect, useState } from 'react';
import { MonitorSmartphone, X } from 'lucide-react';

const QUERY = '(max-width: 767px)';
const DISMISS_KEY = 'tw-small-screen-notice';

function dismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

/** "Best on a larger screen" notice for phones (< 768 px). Dismissible; the choice is remembered in this browser. */
export function SmallScreenNotice() {
  const [small, setSmall] = useState(() => typeof window !== 'undefined' && window.matchMedia(QUERY).matches);
  const [hidden, setHidden] = useState(dismissed);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setSmall(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  if (!small || hidden) return null;
  const close = () => {
    setHidden(true);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* storage unavailable: hide for this visit */ }
  };
  return (
    <div className="tw-small-notice" role="note">
      <MonitorSmartphone size={15} aria-hidden="true" />
      <p>ThreatReady Firewall works best on a larger screen (a tablet in landscape, a laptop or a desktop). On a phone the task panel sits below the lab and wide tables scroll sideways.</p>
      <button type="button" onClick={close} aria-label="Dismiss the larger-screen notice"><X size={13} aria-hidden="true" /></button>
    </div>
  );
}
