// Fixture for tools/test/check-regexp.test.mjs — nothing in this file may be reported.
const SAFE_RE = /^[a-z]+$/;
export function clean(input: string, q: string) {
  const a = new RegExp('lit'); // string literal
  const b = new RegExp("lit", 'i'); // double-quoted literal
  const c = new RegExp(`^lit$`); // template without interpolation
  const d = new RegExp(/lit/, 'g'); // regex literal
  const e = SAFE_RE.test(input); // the argument of test() is the subject, not the pattern
  const f = input.replace(/\s+/g, ' ').split(','); // literal regex / literal string
  const g = q.length > 3 && 'x/y'.split('/'); // division-like slash inside a string
  const h = input.match(/(a+)+$/); // literal regex (its own quality is not this scanner's job)
  // new RegExp(x) inside a comment is ignored, as is "new RegExp(y)" inside a string:
  const i = "new RegExp(y)" + `new RegExp(${input})`;
  const j = 10 / 2 / 5; // division, not a regex literal
  return [a, b, c, d, e, f, g, h, i, j];
}
