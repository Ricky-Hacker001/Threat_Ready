let cached: boolean | undefined;

/**
 * True when the browser can create a WebGL context. Safe to call during SSR and in jsdom
 * (returns false there without touching the canvas API). The result is cached.
 */
export function hasWebGL(): boolean {
  if (cached !== undefined) return cached;
  cached = detect();
  return cached;
}

function detect(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  // jsdom implements <canvas> without a rendering context and logs noisily when asked for one.
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return false;
  try {
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (!gl) return false;
    // Release the probe context straight away so it doesn't count against the browser's limit.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Test hook: forget the cached probe result. */
export function resetWebGLProbe(): void {
  cached = undefined;
}
