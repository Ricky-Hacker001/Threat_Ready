import { describe, expect, it } from 'vitest';
import { bundleCheck, THREE_STACK } from '../vite.config';

type Chunk = { type: 'chunk'; fileName: string; isEntry: boolean; imports: string[]; moduleIds: string[]; code: string };
const chunk = (fileName: string, o: Partial<Chunk> = {}): Chunk => ({ type: 'chunk', fileName, isEntry: false, imports: [], moduleIds: [], code: 'export {}', ...o });
const run = (chunks: Chunk[]) => {
  const plugin = bundleCheck() as unknown as { generateBundle: (this: { error: (m: string) => never }, o: unknown, b: Record<string, Chunk>) => void };
  plugin.generateBundle.call({ error: (m: string) => { throw new Error(m); } }, {}, Object.fromEntries(chunks.map((c) => [c.fileName, c])));
};
const NM = '/repo/node_modules';

describe('build bundle check (TR-57)', () => {
  it('fails the build when a page would load three.js up front', () => {
    expect(() =>
      run([
        chunk('assets/index.js', { isEntry: true, imports: ['assets/three.js'] }),
        chunk('assets/three.js', { moduleIds: [`${NM}/three/build/three.core.js`, `${NM}/react/index.js`] }),
      ]),
    ).toThrow(/three\.js must load only with the 3D interviewer/);
  });

  it('passes when three.js is only reached through a lazy import', () => {
    expect(() =>
      run([
        chunk('assets/index.js', { isEntry: true, imports: ['assets/vendor.js'] }),
        chunk('assets/vendor.js', { moduleIds: [`${NM}/react/index.js`, `${NM}/scheduler/index.js`] }),
        chunk('assets/three.js', { moduleIds: [`${NM}/three/build/three.core.js`] }),
      ]),
    ).not.toThrow();
  });

  it('fails when the first-load JavaScript outgrows the budget', () => {
    let seed = 1;
    const noise = Array.from({ length: 400_000 }, () => String.fromCharCode(33 + ((seed = (seed * 16807) % 2147483647) % 90))).join('');
    expect(() => run([chunk('assets/index.js', { isEntry: true, code: noise })])).toThrow(/budget/);
  });

  it('matches the 3D packages, not React or app code', () => {
    expect(THREE_STACK.test(`${NM}/three/build/three.module.js`)).toBe(true);
    expect(THREE_STACK.test(`${NM}/@react-three/fiber/dist/index.js`)).toBe(true);
    expect(THREE_STACK.test(`${NM}/three-stdlib/index.js`)).toBe(true);
    expect(THREE_STACK.test(`${NM}/react/index.js`)).toBe(false);
    expect(THREE_STACK.test('/repo/apps/web/src/features/interview-prep/avatar/threeHelpers.ts')).toBe(false);
  });
});
