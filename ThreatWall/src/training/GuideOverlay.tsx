import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { useUi } from '../state/ui';
import { TASKS } from '../tasks';
import { currentStep, guideTarget } from './current';

interface Box { top: number; left: number; width: number; height: number; text: string }

/** Outlines the next control the learner must use and points at it with a short instruction. */
export function GuideOverlay() {
  const { state } = useStore();
  const u = useUi();
  const [box, setBox] = useState<Box | null>(null);
  const cur = currentStep(state, u, TASKS);
  const practiceHidden = state.progress.mode === 'practice' && u.reveal !== cur.step?.id;
  const target = cur.step && cur.ctx && !practiceHidden ? guideTarget(cur.step, cur.ctx, u, state.session.loggedIn, cur.task?.steps[cur.index - 1]) : null;
  const selector = target?.selector ?? null;
  const text = target?.text ?? '';

  useEffect(() => {
    if (!selector) { setBox(null); return; }
    let raf = 0;
    let last = '';
    const tick = () => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (el && el.offsetParent !== null) {
        const r = el.getBoundingClientRect();
        const key = `${Math.round(r.top)}:${Math.round(r.left)}:${Math.round(r.width)}:${Math.round(r.height)}`;
        if (key !== last) { last = key; setBox({ top: r.top, left: r.left, width: r.width, height: r.height, text }); }
      } else if (last !== 'none') { last = 'none'; setBox(null); }
      raf = window.setTimeout(tick, 200) as unknown as number;
    };
    tick();
    return () => clearTimeout(raf);
  }, [selector, text]);

  // scroll the target into view when it first appears or when "Show me" is pressed
  useEffect(() => {
    if (!selector) return;
    const el = document.querySelector(selector) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selector, u.flash]);

  if (!box) return null;
  const pad = 4;
  const below = box.top < 120;
  const tipTop = below ? box.top + box.height + pad + 10 : box.top - pad - 10;
  const tipLeft = Math.max(8, Math.min(window.innerWidth - 300, box.left));
  return (
    <div className="tw-guide" aria-hidden="true">
      <div key={u.flash} className="tw-guide-ring" style={{ top: box.top - pad, left: box.left - pad, width: box.width + pad * 2, height: box.height + pad * 2 }} />
      <div className={`tw-guide-tip ${below ? 'below' : 'above'}`} style={{ top: tipTop, left: tipLeft }}>{box.text}</div>
    </div>
  );
}
