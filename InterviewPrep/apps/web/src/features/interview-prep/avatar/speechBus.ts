/**
 * Word timing from speech synthesis to the avatar's lip sync. Speech fires a word event as each
 * word starts; the 3D scene (a separate, lazily loaded chunk) listens without a React re-render
 * per word.
 */
export interface SpokenWord {
  word: string;
  /** performance.now() when the word started. */
  at: number;
  rate: number;
}

type Listener = (w: SpokenWord | null) => void;
const listeners = new Set<Listener>();

export const speechBus = {
  /** A word started; `null` means speech stopped or was interrupted. */
  emit(w: SpokenWord | null) {
    for (const l of listeners) l(w);
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
