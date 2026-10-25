let cached: boolean | undefined;

/**
 * Renderers that draw WebGL on the CPU (no GPU, blocked drivers, VMs, remote desktops). The 3D
 * interviewer would take over the main thread there, so those browsers get the 2D one.
 */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen|apple software/i;

/**
 * True when the browser can render the 3D interviewer: a WebGL context without a "major performance
 * caveat" (the browser's own signal for software rendering) on a hardware renderer. Safe to call during
 * SSR and in jsdom (returns false there without touching the canvas API). The result is cached.
 */
export function hasWebGL(): boolean {
  if (cached !== undefined) return cached;
  cached = detect();
  return cached;
}

/** The unmasked renderer name when the browser exposes it, otherwise the (possibly generic) RENDERER. */
export function rendererName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

export const isSoftwareRenderer = (name: string) => SOFTWARE_RENDERER.test(name);

function detect(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  // jsdom implements <canvas> without a rendering context and logs noisily when asked for one.
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return false;
  try {
    const canvas = document.createElement('canvas');
    const opts: WebGLContextAttributes = { failIfMajorPerformanceCaveat: true };
    const gl =
      (canvas.getContext('webgl2', opts) as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl', opts) as WebGLRenderingContext | null);
    if (!gl) return false;
    const software = isSoftwareRenderer(rendererName(gl));
    // Release the probe context straight away so it doesn't count against the browser's limit.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return !software;
  } catch {
    return false;
  }
}

/** Test hook: forget the cached probe result. */
export function resetWebGLProbe(): void {
  cached = undefined;
}
