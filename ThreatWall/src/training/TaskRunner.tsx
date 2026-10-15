import { useEffect } from 'react';
import { useStore } from '../state/store';
import { useUi } from '../state/ui';
import { advance } from '../tasks/runtime';
import { TASKS } from '../tasks';

/** Re-evaluates task progress whenever state, route or a form draft changes. Renders nothing. */
export function TaskRunner() {
  const { state, setProgress } = useStore();
  const u = useUi();
  useEffect(() => {
    const t = setTimeout(() => {
      const next = advance(state, u, TASKS);
      if (next) setProgress(() => next);
    }, 60);
    return () => clearTimeout(t);
  }, [state, u, setProgress]);
  return null;
}
