import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasWebGL, isSoftwareRenderer, resetWebGLProbe } from '../src/features/interview-prep/avatar/webgl';

/** A canvas whose WebGL context reports `renderer`, or none when the browser flags a major performance caveat. */
function fakeCanvas({ renderer, caveat = false }: { renderer: string; caveat?: boolean }) {
  const requests: { type: string; opts?: WebGLContextAttributes }[] = [];
  const gl = {
    RENDERER: 0x1f01,
    getExtension: (name: string) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : name === 'WEBGL_lose_context' ? { loseContext: () => {} } : null),
    getParameter: (p: number) => (p === 0x9246 ? renderer : 'WebKit WebGL'),
  };
  const canvas = {
    getContext: (type: string, opts?: WebGLContextAttributes) => {
      requests.push({ type, opts });
      return caveat && opts?.failIfMajorPerformanceCaveat ? null : gl;
    },
  };
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => (tag === 'canvas' ? canvas : create(tag))) as typeof document.createElement);
  return requests;
}

beforeEach(() => {
  resetWebGLProbe();
  // The probe skips jsdom; pretend to be a real browser.
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36');
});
afterEach(() => {
  vi.restoreAllMocks();
  resetWebGLProbe();
});

describe('3D interviewer capability probe (TR-32)', () => {
  it('uses 3D on a hardware GPU, asking the browser to refuse slow (software) contexts', () => {
    const requests = fakeCanvas({ renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' });
    expect(hasWebGL()).toBe(true);
    expect(requests[0]).toEqual({ type: 'webgl2', opts: { failIfMajorPerformanceCaveat: true } });
  });

  it('falls back to 2D when the browser reports a major performance caveat', () => {
    fakeCanvas({ renderer: 'ANGLE (Intel)', caveat: true });
    expect(hasWebGL()).toBe(false);
  });

  it('falls back to 2D on software renderers (SwiftShader, llvmpipe, Microsoft Basic Render)', () => {
    for (const renderer of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11)']) {
      resetWebGLProbe();
      vi.mocked(document.createElement).mockRestore?.();
      fakeCanvas({ renderer });
      expect(hasWebGL(), renderer).toBe(false);
    }
    expect(isSoftwareRenderer('Apple M2')).toBe(false);
  });
});
