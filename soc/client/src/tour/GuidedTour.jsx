// Reusable guided tour.
//
// Give it a list of step objects and it draws, for the current step, a
// highlight around the real target element, an arrow from the instruction
// panel to that element, and the panel itself with What / Why / How,
// validation feedback, progress and Back / Next / Skip / Exit controls.
// Positions are measured from the live DOM and follow scrolling, resizing
// and layout changes. It knows nothing about the SOC console: the homepage
// walkthrough and Newbie Demo Mode are two step lists driving this component.
//
// Step shape:
//   id, title, focus (plain-text name of what the arrow points at),
//   target (CSS selector, normally a data-tour attribute), placement
//   ('top' | 'bottom' | 'left' | 'right' | 'auto'), dim (spotlight),
//   dock (selector of a region the panel should sit on, used when the
//   learner has to work next to the target and the panel must stay clear),
//   what, why, how, look, expect, next, more, needs (shown when the target
//   is not on screen), required (has a validation condition), checkLabel.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const GAP = 34;
const MARGIN = 10;

function isVisible(el) {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = window.getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

// First visible match. Hidden tabs are ignored, and a target may list
// fallbacks in order of preference, separated by " || ".
export function findTarget(selector) {
  if (!selector) return null;
  for (const one of String(selector).split(' || ')) {
    let list;
    try { list = document.querySelectorAll(one); } catch { continue; }
    for (const el of list) if (!el.closest('.gt-root') && isVisible(el)) return el;
  }
  return null;
}

// The part of an element that is actually on screen: its box cut down by
// every scrolling ancestor and by the viewport.
function visibleRect(el) {
  const r = el.getBoundingClientRect();
  const box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = window.getComputedStyle(p);
    if (/(auto|scroll|hidden|clip)/.test(`${cs.overflowX} ${cs.overflowY}`)) {
      const pr = p.getBoundingClientRect();
      box.l = Math.max(box.l, pr.left); box.t = Math.max(box.t, pr.top);
      box.r = Math.min(box.r, pr.right); box.b = Math.min(box.b, pr.bottom);
    }
  }
  box.l = Math.max(box.l, 0); box.t = Math.max(box.t, 0);
  box.r = Math.min(box.r, window.innerWidth); box.b = Math.min(box.b, window.innerHeight);
  if (box.r - box.l < 4 || box.b - box.t < 4) return null;
  return { x: Math.round(box.l), y: Math.round(box.t), w: Math.round(box.r - box.l), h: Math.round(box.b - box.t) };
}

function useMedia(query) {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const fn = () => setOn(m.matches);
    m.addEventListener('change', fn);
    return () => m.removeEventListener('change', fn);
  }, [query]);
  return on;
}

// Locate the target for the current step and keep its rectangle up to date.
function useTarget(selector, stepId, sheetSpace) {
  const [state, setState] = useState({ status: selector ? 'searching' : 'none', rect: null });
  const elRef = useRef(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    elRef.current = null;
    if (!selector) { setState({ status: 'none', rect: null }); return undefined; }
    setState({ status: 'searching', rect: null });
    const started = Date.now();
    let dead = false;
    let raf = 0;

    const measure = () => {
      if (dead) return;
      let el = elRef.current;
      if (!el || !isVisible(el)) {
        el = findTarget(selector);
        if (el && el !== elRef.current) {
          elRef.current = el;
          // Bring it into view once, leaving room for the instruction sheet on small screens.
          const r0 = el.getBoundingClientRect();
          const bottomLimit = window.innerHeight - sheetSpace();
          if (r0.top < 60 || r0.bottom > bottomLimit || !visibleRect(el)) {
            el.scrollIntoView({ block: sheetSpace() ? 'start' : 'center', inline: 'nearest' });
            if (sheetSpace()) window.scrollBy(0, -70);
          }
        }
        if (!el) elRef.current = null;
      }
      if (!el) {
        setState((s) => {
          const status = Date.now() - started > 2200 ? 'missing' : 'searching';
          return s.status === status && !s.rect ? s : { status, rect: null };
        });
        return;
      }
      // null when the learner has scrolled it out of sight: the highlight is dropped, not chased.
      const rect = visibleRect(el);
      setState((s) => {
        if (s.status === 'found' && ((!s.rect && !rect) || (s.rect && rect && s.rect.x === rect.x && s.rect.y === rect.y && s.rect.w === rect.w && s.rect.h === rect.h))) return s;
        return { status: 'found', rect };
      });
    };
    const soon = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };

    measure();
    const timer = setInterval(measure, 200);
    window.addEventListener('resize', soon);
    window.addEventListener('scroll', soon, true);
    return () => { dead = true; clearInterval(timer); cancelAnimationFrame(raf); window.removeEventListener('resize', soon); window.removeEventListener('scroll', soon, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selector, stepId, nonce]);

  return { ...state, retry: () => setNonce((n) => n + 1) };
}

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Choose where the panel goes so it does not cover what it is pointing at.
function place(target, size, want, dock) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxX = Math.max(MARGIN, vw - size.w - MARGIN);
  const maxY = Math.max(MARGIN, vh - size.h - MARGIN);
  if (dock && dock.w >= size.w * 0.9) {
    const p = {
      x: clamp(dock.x + (dock.w - size.w) / 2, MARGIN, maxX),
      y: clamp(target ? target.y + target.h / 2 - size.h / 2 : dock.y + 8, Math.min(maxY, Math.max(MARGIN, dock.y + 8)), maxY),
    };
    if (!target || overlap({ ...p, ...size }, target) === 0) return { ...p, side: 'dock' };
  }
  if (!target) return { x: clamp((vw - size.w) / 2, MARGIN, maxX), y: clamp((vh - size.h) / 2, MARGIN, maxY), side: null };
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  const at = {
    right: { x: target.x + target.w + GAP, y: cy - size.h / 2 },
    left: { x: target.x - GAP - size.w, y: cy - size.h / 2 },
    bottom: { x: cx - size.w / 2, y: target.y + target.h + GAP },
    top: { x: cx - size.w / 2, y: target.y - GAP - size.h },
  };
  const order = [...new Set([want, 'right', 'left', 'bottom', 'top'].filter((s) => at[s]))];
  let best = null;
  for (const side of order) {
    const raw = at[side];
    const p = { x: clamp(raw.x, MARGIN, maxX), y: clamp(raw.y, MARGIN, maxY) };
    const cover = overlap({ ...p, ...size }, target);
    if (cover === 0) return { ...p, side };
    if (!best || cover < best.cover) best = { ...p, side, cover };
  }
  // Nothing clears the target (it fills the screen): use the corner that hides least of it.
  for (const p of [{ x: maxX, y: maxY }, { x: MARGIN, y: maxY }, { x: maxX, y: MARGIN }, { x: MARGIN, y: MARGIN }]) {
    const cover = overlap({ ...p, ...size }, target);
    if (cover < best.cover) best = { ...p, side: 'corner', cover };
  }
  return best;
}

// Arrow from the edge of the panel to the edge of the target.
function arrowBetween(panel, target) {
  if (!panel || !target || overlap(panel, target) > 0) return null;
  const pc = { x: panel.x + panel.w / 2, y: panel.y + panel.h / 2 };
  const end = { x: clamp(pc.x, target.x + Math.min(14, target.w / 2), target.x + target.w - Math.min(14, target.w / 2)), y: clamp(pc.y, target.y + Math.min(10, target.h / 2), target.y + target.h - Math.min(10, target.h / 2)) };
  // Snap the end to the nearest edge of the target facing the panel.
  const dx = pc.x < target.x ? target.x - pc.x : pc.x > target.x + target.w ? pc.x - (target.x + target.w) : 0;
  const dy = pc.y < target.y ? target.y - pc.y : pc.y > target.y + target.h ? pc.y - (target.y + target.h) : 0;
  if (dx >= dy) end.x = pc.x < target.x ? target.x - 5 : target.x + target.w + 5;
  else end.y = pc.y < target.y ? target.y - 5 : target.y + target.h + 5;
  const start = { x: clamp(end.x, panel.x + 16, panel.x + panel.w - 16), y: clamp(end.y, panel.y + 16, panel.y + panel.h - 16) };
  if (dx >= dy) start.x = end.x > pc.x ? panel.x + panel.w : panel.x;
  else start.y = end.y > pc.y ? panel.y + panel.h : panel.y;
  const len = Math.hypot(end.x - start.x, end.y - start.y);
  if (len < 14) return null;
  end.x = clamp(end.x, 6, window.innerWidth - 6);
  end.y = clamp(end.y, 6, window.innerHeight - 6);
  return { start, end };
}

function Section({ label, children }) {
  if (!children) return null;
  return (
    <div className="gt-sec">
      <h3>{label}</h3>
      <p>{children}</p>
    </div>
  );
}

export function ResultNote({ result, busy }) {
  return (
    <div className="gt-result-wrap" aria-live="polite" role="status">
      {busy && <p className="gt-result gt-info">Checking…</p>}
      {!busy && result && (result.message || result.items?.length > 0) && (
        <div className={`gt-result ${result.ok ? (result.warn ? 'gt-warn' : 'gt-ok') : 'gt-bad'}`}>
          {result.message && <p><strong>{result.ok ? (result.warn ? 'Recorded: ' : 'Correct: ') : 'Not yet: '}</strong>{result.message}</p>}
          {result.items?.some((i) => i.label) && (
            <ul>
              {result.items.filter((i) => i.label).map((i) => (
                <li key={i.id}><span className="gt-mark" aria-hidden="true">{i.ok ? '✓' : '✗'}</span><span><strong>{i.label}:</strong> {i.message}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function GuidedTour({
  steps, index, label,
  progress,                 // { value, max, text }
  isDone = () => false,     // (step) => validation condition met
  result = () => null,      // (step) => last validation result
  busy = false,
  onBack, onNext, onCheck, onSkip, onRetarget,
  nextLabel, canSkip = () => true,
  menu = [],                // exit / pause / restart: [{ label, hint, onClick, danger }]
  stepList,                 // optional review list: [{ key, label, status, disabled, onClick }]
  renderWidget,             // (step) => extra interactive content for the step
  notice,                   // optional line shown above the step (for example an API failure)
}) {
  const step = steps[index];
  const mobile = useMedia('(max-width: 760px)');
  const [min, setMin] = useState(false);
  const [open, setOpen] = useState(null); // 'menu' | 'steps' | null
  const [more, setMore] = useState(false);
  const panelRef = useRef(null);
  const headRef = useRef(null);
  const lastPos = useRef({ id: null, pos: null });
  const [size, setSize] = useState({ w: 384, h: 320 });
  const sheetSpace = useCallback(() => (window.matchMedia('(max-width: 760px)').matches ? Math.min(window.innerHeight * 0.6, (panelRef.current?.offsetHeight || 0) + 10) : 0), []);
  const tgt = useTarget(step?.target, step?.id, sheetSpace);
  const widget = renderWidget ? renderWidget(step) : null;
  const wide = !!widget;

  useEffect(() => { setMore(false); setOpen(null); setMin(false); }, [step?.id]);
  useEffect(() => { headRef.current?.focus({ preventScroll: true }); }, [step?.id]);

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return undefined;
    const read = () => setSize((s) => (s.w === el.offsetWidth && s.h === el.offsetHeight ? s : { w: el.offsetWidth, h: el.offsetHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [step?.id, min, wide, mobile]);

  // Leave room under the page for the bottom sheet on small screens.
  useEffect(() => {
    if (!mobile) return undefined;
    document.body.style.paddingBottom = `${min ? 64 : Math.round(window.innerHeight * 0.6)}px`;
    return () => { document.body.style.paddingBottom = ''; };
  }, [mobile, min]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { if (open) setOpen(null); else setMin((m) => !m); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!step) return null;

  let rect = tgt.status === 'found' ? tgt.rect : null;
  // On a small screen the sheet covers the lower part of the page: highlight
  // only what shows above it, so the arrow still has somewhere to land.
  if (mobile && rect && !min) {
    const room = window.innerHeight - size.h - 44 - rect.y;
    rect = room >= 24 ? { ...rect, h: Math.min(rect.h, room) } : null;
  }
  // While a found target is scrolled out of sight, the panel stays where it was.
  const hold = tgt.status === 'found' && !rect && lastPos.current.id === step.id;
  const dockEl = !mobile && step.dock && !wide ? findTarget(step.dock) : null;
  const dr = dockEl ? dockEl.getBoundingClientRect() : null;
  const dock = dr ? { x: dr.left, y: dr.top, w: dr.width, h: dr.height } : null;
  const pos = mobile ? null : hold ? lastPos.current.pos : place(rect, size, step.placement || 'auto', dock);
  if (!mobile && !hold) lastPos.current = { id: step.id, pos };
  const panelBox = mobile
    ? { x: 0, y: window.innerHeight - size.h, w: window.innerWidth, h: size.h }
    : { x: pos.x, y: pos.y, w: size.w, h: size.h };
  const arrow = rect ? arrowBetween(panelBox, rect) : null;
  const done = isDone(step);
  const res = result(step);
  const last = index === steps.length - 1;
  const primaryIsCheck = step.required && !done;
  const style = mobile ? undefined : { left: `${pos.x}px`, top: `${pos.y}px` };
  const ring = rect ? (() => {
    const l = Math.max(3, rect.x - 5);
    const tp = Math.max(3, rect.y - 5);
    return { left: l, top: tp, width: Math.min(window.innerWidth - 3, rect.x + rect.w + 5) - l, height: Math.min(window.innerHeight - 3, rect.y + rect.h + 5) - tp };
  })() : null;

  return (
    <div className="gt-root">
      {ring && <div className={`gt-ring${step.dim && !min ? ' gt-dim' : ''}`} style={ring} aria-hidden="true" />}
      {arrow && !min && (
        <svg className="gt-arrow" aria-hidden="true" width="100%" height="100%">
          <defs>
            <marker id="gt-head" viewBox="0 0 12 12" refX="9" refY="6" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M1 1 L11 6 L1 11 z" className="gt-head" />
            </marker>
          </defs>
          <line x1={arrow.start.x} y1={arrow.start.y} x2={arrow.end.x} y2={arrow.end.y} className="gt-line-under" />
          <line x1={arrow.start.x} y1={arrow.start.y} x2={arrow.end.x} y2={arrow.end.y} className="gt-line" markerEnd="url(#gt-head)" />
        </svg>
      )}

      <section
        ref={panelRef} style={style} role="dialog" aria-modal="false" aria-labelledby="gt-title" aria-describedby="gt-focus"
        className={`gt-panel${mobile ? ' gt-sheet' : ''}${wide ? ' gt-wide' : ''}${min ? ' gt-min' : ''}`}
        data-step={step.id} data-target={tgt.status}
      >
        <header className="gt-head-row">
          <p className="gt-eyebrow">
            <span className="gt-label">{label}</span>
            {progress?.text && <span>{progress.text}</span>}
          </p>
          <div className="gt-tools">
            {stepList && !min && <button type="button" className="gt-tool" onClick={() => setOpen(open === 'steps' ? null : 'steps')} aria-expanded={open === 'steps'}>Steps</button>}
            <button type="button" className="gt-tool" onClick={() => setMin(!min)} aria-expanded={!min}>{min ? 'Show' : 'Hide'}</button>
            {menu.length > 0 && !min && <button type="button" className="gt-tool" onClick={() => setOpen(open === 'menu' ? null : 'menu')} aria-expanded={open === 'menu'}>Exit</button>}
          </div>
        </header>
        {progress && !min && (
          <div className="gt-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.max} aria-valuenow={progress.value} aria-label="Tour progress">
            <span style={{ width: `${progress.max ? Math.round((progress.value / progress.max) * 100) : 0}%` }} />
          </div>
        )}

        <h2 id="gt-title" ref={headRef} tabIndex={-1}>{step.title}</h2>

        {!min && open === 'menu' && (
          <div className="gt-menu">
            {menu.map((m) => (
              <button type="button" key={m.label} className={`gt-menu-item${m.danger ? ' is-danger' : ''}`} onClick={() => { setOpen(null); m.onClick(); }}>
                <strong>{m.label}</strong>
                {m.hint && <span>{m.hint}</span>}
              </button>
            ))}
            <button type="button" className="link" onClick={() => setOpen(null)}>Keep going</button>
          </div>
        )}

        {!min && open === 'steps' && stepList && (
          <ol className="gt-steps">
            {stepList.map((s) => (
              <li key={s.key}>
                <button type="button" disabled={s.disabled} aria-current={s.current ? 'step' : undefined} onClick={() => { setOpen(null); s.onClick(); }}>
                  <span>{s.label}</span>
                  <span className="gt-step-status">{s.status}</span>
                </button>
              </li>
            ))}
          </ol>
        )}

        {!min && !open && (
          <div className="gt-body">
            {notice && <p className="gt-result gt-bad" role="alert">{notice}</p>}
            <p className="gt-focus" id="gt-focus">
              <span className="gt-focus-k">{step.target ? 'Arrow points at' : 'Focus'}</span> {step.focus}
            </p>
            {step.target && tgt.status === 'missing' && (
              <div className="gt-missing" role="status">
                <p>{step.needs || 'The item this step points at is not on screen right now. You can still read the step, bring it back, or carry on.'}</p>
                <div className="gt-row">
                  {onRetarget && <button type="button" className="btn btn-sm" onClick={() => { onRetarget(step); tgt.retry(); }}>Take me there</button>}
                  <button type="button" className="btn btn-sm" onClick={tgt.retry}>Try again</button>
                </div>
              </div>
            )}
            <Section label="What">{step.what}</Section>
            <Section label="Why">{step.why}</Section>
            <Section label={step.required ? 'How (your task)' : 'How'}>{step.how}</Section>
            <Section label="Expected result">{step.expect}</Section>
            {(step.look || step.next || step.more) && (
              <div className="gt-more">
                <button type="button" className="link" onClick={() => setMore(!more)} aria-expanded={more}>{more ? 'Show less' : 'Learn more'}</button>
                {more && (
                  <>
                    <Section label="What to look for">{step.look}</Section>
                    <Section label="What happens next">{step.next}</Section>
                    <Section label="More">{step.more}</Section>
                  </>
                )}
              </div>
            )}
            {widget}
            {step.required && <ResultNote result={res} busy={busy} />}
          </div>
        )}

        {!min && !open && (
          <footer className="gt-foot">
            <button type="button" className="btn btn-sm" onClick={onBack} disabled={index === 0 || busy}>Back</button>
            {!step.required && !last && onSkip && canSkip(step) && <button type="button" className="link" onClick={() => onSkip(step)} disabled={busy}>Skip this step</button>}
            <span className="grow" />
            {step.required && !done && !last && <span className="gt-need">Needed to continue</span>}
            {primaryIsCheck
              ? <button type="button" className="btn btn-primary btn-sm" onClick={() => onCheck(step)} disabled={busy}>{busy ? 'Checking…' : res && !res.ok ? (step.retryLabel || 'Check again') : (step.checkLabel || 'Check')}</button>
              : <button type="button" className="btn btn-primary btn-sm" onClick={onNext} disabled={busy}>{nextLabel ? nextLabel(step, last) : last ? 'Finish' : 'Next'}</button>}
          </footer>
        )}
      </section>
    </div>
  );
}
