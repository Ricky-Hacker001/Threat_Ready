// Fixture for tools/test/check-regexp.test.mjs — every line below carrying a FLAG marker must be reported.
export function compile(x: string, name: string, pattern: string, input: string, body: { pattern: string }) {
  const a = new RegExp(x); // FLAG R1
  const b = RegExp(x, 'g'); // FLAG R1
  const c = new RegExp(`^${name}=`); // FLAG R1 (interpolated template)
  const d = 'abc'.match(pattern); // FLAG R2
  const e = 'abc'.replace(input, ''); // FLAG R2
  const f = 'a,b'.split(body.pattern); // FLAG R2 (member chain ending in pattern)
  const g = pattern.test('abc'); // FLAG R3
  return [a, b, c, d, e, f, g];
}
