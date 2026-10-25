import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real Canvas needs WebGL; this one records its props and renders its children with a fake R3F state.
const r3f = vi.hoisted(() => ({ invalidate: undefined as unknown as ReturnType<typeof vi.fn>, props: {} as Record<string, unknown> }));
vi.mock('@react-three/fiber', async () => {
  const THREE = await import('three');
  const camera = new THREE.PerspectiveCamera(24, 1, 0.05, 30);
  camera.position.set(0.3, 1.32, 2.05);
  return {
    Canvas: (props: { children?: ReactNode } & Record<string, unknown>) => {
      r3f.props = props;
      return <>{props.children}</>;
    },
    useThree: (select: (s: unknown) => unknown) => select({ invalidate: r3f.invalidate, camera, size: { width: 400, height: 300 }, gl: {}, scene: {} }),
    useFrame: () => {},
  };
});
vi.mock('@react-three/drei', () => ({ PerformanceMonitor: () => null }));
// An already-loaded model (a settled thenable), so nothing suspends.
vi.mock('../src/features/interview-prep/avatar/loadModel', async () => {
  const THREE = await import('three');
  const gltf = { scene: new THREE.Group(), animations: [] };
  const loaded = Object.assign(Promise.resolve(gltf), { status: 'fulfilled', value: gltf });
  return { loadInterviewerModel: () => loaded };
});
vi.mock('../src/features/interview-prep/avatar/Effects', () => ({ Effects: () => null }));
vi.mock('../src/features/interview-prep/avatar/Room', () => ({ Room: () => null }));
vi.mock('../src/features/interview-prep/avatar/useInterviewerAnimation', () => ({ createRig: () => ({}), useInterviewerAnimation: () => {} }));

import InterviewerScene from '../src/features/interview-prep/avatar/InterviewerScene';

function prefersReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener: () => {}, removeEventListener: () => {} }));
}
const scene = (speaking: boolean) => <InterviewerScene status="listening" speaking={speaking} onReady={() => {}} onContextLost={() => {}} />;

const invalidate = vi.fn();
beforeEach(() => {
  // react-dom does not know R3F's <primitive>; that warning is expected here.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  invalidate.mockClear();
  r3f.invalidate = invalidate;
  r3f.props = {};
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('3D interviewer render loop (TR-32)', () => {
  it('renders every frame normally, with the default (not high-performance) GPU preference', () => {
    prefersReducedMotion(false);
    render(scene(false));
    expect(r3f.props.frameloop).toBe('always');
    expect((r3f.props.gl as { powerPreference: string }).powerPreference).toBe('default');
  });

  // Fake timers drive setTimeout, setInterval and requestAnimationFrame, so the counts don't depend on machine load.
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  it('with reduced motion the loop stops: frames only on demand', async () => {
    prefersReducedMotion(true);
    vi.useFakeTimers();
    render(scene(false));
    expect(r3f.props.frameloop).toBe('demand');
    // A short burst settles the face, then nothing until a blink 3-6 s later.
    await wait(1_000);
    const settled = invalidate.mock.calls.length;
    expect(settled).toBeGreaterThan(0);
    await wait(1_900);
    expect(invalidate.mock.calls.length).toBe(settled);
    // …until the first blink burst, 3-6 s after the start.
    await wait(4_000);
    expect(invalidate.mock.calls.length).toBeGreaterThan(settled);
  });

  it('with reduced motion, lip sync still gets frames while Alex speaks', async () => {
    prefersReducedMotion(true);
    vi.useFakeTimers();
    render(scene(true));
    await wait(1_000);
    const before = invalidate.mock.calls.length;
    await wait(1_000);
    expect(invalidate.mock.calls.length - before).toBeGreaterThanOrEqual(29);
  });

  it('stops rendering entirely while the tab is hidden', () => {
    prefersReducedMotion(false);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    render(scene(false));
    expect(r3f.props.frameloop).toBe('never');
  });
});
