import { useEffect, useState } from 'react';

const QUERY = '(max-width: 767px)';
// Deliberately outside the devsecops-lab: progress prefix: a per-device display preference, not learner progress.
const DISMISS_KEY = 'devsecops-ui:small-screen-notice';

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** "Best on a larger screen" notice for phones (< 768 px). Dismissible; the choice is remembered on this device. */
export function SmallScreenNotice() {
  const [small, setSmall] = useState(() => window.matchMedia(QUERY).matches);
  const [hidden, setHidden] = useState(dismissed);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setSmall(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  if (!small || hidden) return null;
  return (
    <div className="smallnote" role="note">
      <p>
        The DevSecOps Lab works best on a larger screen (a tablet in landscape, a laptop or a desktop). On a phone, open files with the <b>File</b> picker above
        the editor, and the terminal sits below it.
      </p>
      <button
        type="button"
        className="btn sm ghost"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(DISMISS_KEY, '1');
          } catch {
            /* storage unavailable: hide for this visit */
          }
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
