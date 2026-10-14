import { useSyncExternalStore } from 'react';

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReduced(cb: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener?.('change', cb);
  return () => mq.removeEventListener?.('change', cb);
}
const getReduced = () => (typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(REDUCED_QUERY).matches);

/** Live `prefers-reduced-motion` flag. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, getReduced, () => false);
}

function subscribeVisibility(cb: () => void) {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
}
const getVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** False while the tab is hidden, so the render loop can stop. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, getVisible, () => true);
}
