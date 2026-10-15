/**
 * Ephemeral UI state that tasks need to observe but that must not be persisted:
 * current route, Lab Tools drawer, and in-progress form drafts (what the learner has typed but not saved yet).
 */
import { useEffect, useSyncExternalStore } from 'react';

interface UiState {
  route: string;
  labOpen: boolean;
  labTab: string;
  drafts: Record<string, unknown>;
  reveal: string | null;
  flash: number;
  rev: number;
}

let state: UiState = { route: '', labOpen: false, labTab: 'traffic', drafts: {}, reveal: null, flash: 0, rev: 0 };
const subs = new Set<() => void>();
const emit = () => { state = { ...state, rev: state.rev + 1 }; subs.forEach((f) => f()); };

export const ui = {
  get: () => state,
  subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  setRoute(route: string) { if (state.route !== route) { state = { ...state, route }; emit(); } },
  openLab(tab?: string) { state = { ...state, labOpen: true, labTab: tab ?? state.labTab }; emit(); },
  closeLab() { state = { ...state, labOpen: false }; emit(); },
  setLabTab(tab: string) { state = { ...state, labTab: tab }; emit(); },
  setReveal(step: string | null) { state = { ...state, reveal: step }; emit(); },
  flashGuide() { state = { ...state, flash: state.flash + 1 }; emit(); },
  setDraft(key: string, value: unknown) { state = { ...state, drafts: { ...state.drafts, [key]: value } }; emit(); },
  clearDraft(key: string) { if (key in state.drafts) { const d = { ...state.drafts }; d[`${key}:last`] = d[key]; delete d[key]; state = { ...state, drafts: d }; emit(); } },
};

export function useUi(): UiState {
  return useSyncExternalStore(ui.subscribe, ui.get);
}

/** Publish a form draft so the guided task can watch the learner fill it in. Cleared when the form closes. */
export function useDraft(key: string, value: unknown) {
  const json = JSON.stringify(value);
  useEffect(() => { ui.setDraft(key, JSON.parse(json)); }, [key, json]);
  useEffect(() => () => ui.clearDraft(key), [key]);
}

export function draft<T>(key: string): T | undefined {
  return state.drafts[key] as T | undefined;
}
