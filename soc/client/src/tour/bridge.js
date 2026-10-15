// A small meeting point between the console and the guided tours.
// The console registers how to switch tabs and read its current search and
// form; a tour uses that instead of reaching into component internals.

const listeners = new Set();

export const bridge = {
  view: null, // { id, tab(), setTab(k), search(), cs(), refresh() }
  form: null, // { stage, get() -> { values, links } }
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(what) { listeners.forEach((fn) => { try { fn(what); } catch { /* a listener must not break the console */ } }); },
};

export function waitFor(test, ms = 6000, every = 80) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      let v = null;
      try { v = test(); } catch { v = null; }
      if (v) resolve(v);
      else if (Date.now() - t0 > ms) resolve(null);
      else setTimeout(tick, every);
    };
    tick();
  });
}
