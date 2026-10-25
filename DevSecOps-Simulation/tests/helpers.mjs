// Shared test helpers.

/** localStorage stand-in: keys are own enumerable properties, so Object.keys(localStorage) works as in a browser. */
export class FakeStorage {
  getItem(k) {
    return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null;
  }
  setItem(k, v) {
    this[k] = String(v);
  }
  removeItem(k) {
    delete this[k];
  }
}

let n = 0;
/** A new instance of a module (its own module state), as on a fresh page load. Its own imports are shared. */
export const freshImport = (url) => import(`${url.href}?fresh=${++n}`);
