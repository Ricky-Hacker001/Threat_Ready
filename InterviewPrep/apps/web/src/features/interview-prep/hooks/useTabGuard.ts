import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';

/** Whether the server keeps a count of tab switches for the report: unknown until the first one. */
export type TabSwitchRecording = 'unknown' | 'recorded' | 'not-recorded';

/**
 * Interview integrity: browsers never let a page stop the candidate switching tabs, so while the
 * interview is running this notices when the tab is hidden and, on return, tells the API how long it
 * was away (POST …/tab-hidden, noted in the report, never scored) and asks the room to show a reminder.
 * Leaving the page itself (close, reload, navigate away) gets the browser's own prompt. The count is
 * kept per session for this tab, so a refresh doesn't reset it. An API without the endpoint (404) just
 * means nothing is recorded, and the reminder says so.
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
  const [recording, setRecording] = useState<TabSwitchRecording>('unknown');

  useEffect(() => {
    if (!active) return;
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt ??= Date.now();
        return;
      }
      if (hiddenAt == null) return;
      const hiddenMs = Math.min(Date.now() - hiddenAt, 24 * 3_600_000);
      hiddenAt = null;
      // Fire and forget: the reminder never waits for it, and a failure is never shown.
      api.tabHidden(sessionId, hiddenMs).then(
        () => setRecording('recorded'),
        (e: unknown) => {
          if (e instanceof ApiError && (e.status === 404 || e.status === 405)) setRecording('not-recorded');
        },
      );
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
  }, [active, key, sessionId]);

  const dismiss = useCallback(() => setWarning(false), []);
  return { count, warning: warning && active, dismiss, recording };
}
