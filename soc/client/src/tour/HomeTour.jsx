// Homepage walkthrough ("Take a walkthrough"). Optional interface tour.
// It never starts a case: console screens are shown on read-only sample
// tickets that the server keeps in memory.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import GuidedTour, { findTarget } from './GuidedTour.jsx';
import { HOME_TOUR } from './homeTourSteps.js';
import { bridge, waitFor } from './bridge.js';
import { demoApi } from '../api.js';

const KEY = 'soc-sim-tour';
export const tourStore = {
  get() { try { const v = window.sessionStorage.getItem(KEY); return v === null ? null : Math.min(HOME_TOUR.length - 1, Math.max(0, Number(v) || 0)); } catch { return null; } },
  set(i) { try { if (i === null) window.sessionStorage.removeItem(KEY); else window.sessionStorage.setItem(KEY, String(i)); } catch { /* storage unavailable */ } },
};

const onHome = () => /^#?\/?$/.test(window.location.hash);

export default function HomeTour({ initial = 0, onClose }) {
  const [index, setIndex] = useState(initial);
  const [seen, setSeen] = useState(() => new Set());
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = useRef(0);
  const step = HOME_TOUR[index];

  // Put the right screen behind the step: home page, or a sample ticket on the right tab.
  const prepare = useCallback(async (s) => {
    const mine = ++run.current;
    setNotice(null);
    try {
      if (s.where === 'home') {
        if (!onHome()) window.location.hash = '#/';
        return;
      }
      setBusy(true);
      const p = await demoApi.preview(s.where);
      if (mine !== run.current) return;
      if (window.location.hash !== `#/case/${p.id}`) window.location.hash = `#/case/${p.id}`;
      const view = await waitFor(() => (bridge.view?.id === p.id && bridge.view.cs() ? bridge.view : null), 8000);
      if (mine !== run.current) return;
      if (!view) throw new Error('timeout');
      if (s.tab) view.setTab(s.tab);
      if (s.open) {
        const el = await waitFor(() => findTarget(s.open), 4000);
        if (mine === run.current && el && !document.querySelector('[data-tour~="log-detail"]')) el.click();
      }
    } catch {
      if (mine === run.current) setNotice('The sample ticket for this step could not be loaded. You can read the step, press "Take me there" to try again, or carry on.');
    } finally {
      if (mine === run.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    tourStore.set(index);
    setSeen((prev) => new Set(prev).add(HOME_TOUR[index].id));
    prepare(HOME_TOUR[index]);
  }, [index, prepare]);

  const close = () => {
    run.current++;
    tourStore.set(null);
    // Leaving the tour while a sample ticket is open returns to the home page.
    if (bridge.view?.cs()?.kind === 'preview') window.location.hash = '#/';
    onClose();
  };

  const go = (i) => setIndex(Math.min(HOME_TOUR.length - 1, Math.max(0, i)));

  return (
    <GuidedTour
      steps={HOME_TOUR} index={index} label="Walkthrough"
      progress={{ value: index + 1, max: HOME_TOUR.length, text: `${index + 1} of ${HOME_TOUR.length}` }}
      busy={busy}
      notice={notice}
      onBack={() => go(index - 1)}
      onNext={() => (index === HOME_TOUR.length - 1 ? close() : go(index + 1))}
      onSkip={() => go(index + 1)}
      onRetarget={prepare}
      nextLabel={(s, last) => (index === 0 ? 'Start' : last ? 'Finish' : 'Next')}
      menu={[
        { label: 'Exit the walkthrough', hint: 'Closes the tour. Nothing was started or saved.', onClick: close },
        { label: 'Restart from the first step', hint: 'Goes back to the welcome step.', onClick: () => go(0) },
      ]}
      stepList={HOME_TOUR.map((s, i) => ({ key: s.id, label: `${i + 1}. ${s.title}`, status: i === index ? 'Current' : seen.has(s.id) ? 'Seen' : '', current: i === index, onClick: () => go(i) }))}
    />
  );
}
