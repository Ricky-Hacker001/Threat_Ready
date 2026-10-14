import { useCallback, useEffect, useState } from 'react';

/**
 * Interview integrity: browsers never let a page stop the candidate switching tabs, so while the
 * interview is running this notices when the tab is hidden and, on return, asks the room to show a
 * warning. Leaving the page itself (close, reload, navigate away) gets the browser's own prompt.
 * The count is kept per session for this tab, so a refresh doesn't reset it.
 */
export function useTabGuard(sessionId: string, active: boolean) {
  const key = `tr:tab-switches:${sessionId}`;
  const [count, setCount] = useState(() => {
    try {
      return Number(window.sessionStorage.getItem(key)) || 0;
    } catch {
      return 0;
    }
  });
  const [warning, setWarning] = useState(false);

  useEffect(() => {
    if (!active) return;
    let left = false;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        left = true;
        return;
      }
      if (!left) return;
      left = false;
      setCount((c) => {
        const next = c + 1;
        try {
          window.sessionStorage.setItem(key, String(next));
        } catch {
          /* storage unavailable */
        }
        return next;
      });
      setWarning(true);
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // older Chrome and Safari need it set to show the prompt
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [active, key]);

  const dismiss = useCallback(() => setWarning(false), []);
  return { count, warning: warning && active, dismiss };
}
