import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type { AuditEntry, FirewallConfig, LabControls, LabEvent, LabSession, Progress, RootState, LogEntry } from './types';
import { STATE_VERSION, initialLab, initialPm, initialProgress, initialSession, initialState } from './baseline';
import { uid } from '../lib/hash';
import { migrateLegacyKey, nsKey } from '../lib/storage';
import { evaluate, type FlowResult, type FlowSpec } from '../engine/traffic';
import { applyEffects, addLogs } from '../engine/effects';

// Namespaced per signed-in ThreatReady account (see lib/storage.ts); resolved at boot in main.tsx.
const LEGACY_STORAGE_KEY = 'threatwall:lab-state';
const storageKey = () => nsKey(LEGACY_STORAGE_KEY);
const MAX_EVENTS = 400;

export type AuditInput = Omit<AuditEntry, 'id' | 'ts' | 'user'>;

type Action =
  | { type: 'config/commit'; next: FirewallConfig; audit: AuditInput[] }
  | { type: 'session/patch'; patch: Partial<LabSession> }
  | { type: 'lab/patch'; patch: Partial<LabControls>; audit?: AuditInput[] }
  | { type: 'progress/set'; fn: (p: Progress) => Progress }
  | { type: 'audit/add'; entries: AuditInput[] }
  | { type: 'logs/add'; logs: Omit<LogEntry, 'id'>[] }
  | { type: 'event'; event: Omit<LabEvent, 'id' | 'ts'> }
  | { type: 'update'; fn: (s: RootState) => RootState }
  | { type: 'lab/reset' };

function stamp(state: RootState, entries: AuditInput[], configChange = false): AuditEntry[] {
  const user = state.session.user ?? (configChange ? state.config.system.adminUser : 'system');
  const now = Date.now();
  return entries.map((e, i) => ({ ...e, id: uid(), ts: now + i, user }));
}

function pushEvent(s: RootState, e: Omit<LabEvent, 'id' | 'ts'>): RootState {
  const ev: LabEvent = { ...e, id: uid(), ts: Date.now() };
  return { ...s, progress: { ...s.progress, events: [...s.progress.events, ev].slice(-MAX_EVENTS) } };
}

function reducer(state: RootState, action: Action): RootState {
  switch (action.type) {
    case 'config/commit': {
      const next = {
        ...state,
        config: action.next,
        audit: [...stamp(state, action.audit, true), ...state.audit].slice(0, 600),
        session: { ...state.session, lastActivity: Date.now() },
      };
      return action.audit.length ? pushEvent(next, { type: 'save', data: { actions: action.audit.map((a) => a.action) } }) : next;
    }
    case 'session/patch':
      return { ...state, session: { ...state.session, ...action.patch } };
    case 'lab/patch': {
      const next = { ...state, lab: { ...state.lab, ...action.patch } };
      return action.audit?.length ? { ...next, audit: [...stamp(state, action.audit), ...state.audit].slice(0, 600) } : next;
    }
    case 'progress/set':
      return { ...state, progress: action.fn(state.progress) };
    case 'audit/add':
      return { ...state, audit: [...stamp(state, action.entries), ...state.audit].slice(0, 600) };
    case 'logs/add':
      return addLogs(state, action.logs);
    case 'event':
      return pushEvent(state, action.event);
    case 'update':
      return action.fn(state);
    case 'lab/reset': {
      const fresh = initialState();
      return { ...fresh, audit: stamp(fresh, [{ category: 'Lab', action: 'Lab reset', detail: 'Appliance restored to factory defaults; progress cleared.' }]) };
    }
    default:
      return state;
  }
}

function load(): RootState {
  try {
    migrateLegacyKey(LEGACY_STORAGE_KEY);
    const raw = localStorage.getItem(storageKey());
    if (!raw) return initialState();
    const parsed = JSON.parse(raw) as RootState;
    if (!parsed || parsed.version !== STATE_VERSION || !parsed.config) return initialState();
    return {
      ...parsed,
      session: { ...initialSession(), ...parsed.session },
      lab: { ...initialLab(), ...parsed.lab },
      progress: { ...initialProgress(), ...parsed.progress },
      pm: { ...initialPm(), ...parsed.pm },
      logs: parsed.logs ?? [],
    };
  } catch {
    return initialState();
  }
}

export interface StoreValue {
  state: RootState;
  config: FirewallConfig;
  session: LabSession;
  lab: LabControls;
  progress: Progress;
  commit: (next: FirewallConfig, audit: AuditInput[]) => void;
  patchSession: (patch: Partial<LabSession>) => void;
  patchLab: (patch: Partial<LabControls>, audit?: AuditInput[]) => void;
  setProgress: (fn: (p: Progress) => Progress) => void;
  addAudit: (entries: AuditInput[]) => void;
  addLogs: (logs: Omit<LogEntry, 'id'>[]) => void;
  emit: (type: string, data?: Record<string, unknown>) => void;
  update: (fn: (s: RootState) => RootState) => void;
  /** Send simulated traffic: evaluates, applies counters/logs/captures, records a 'test' event. */
  sendFlow: (spec: FlowSpec, opts?: { at?: number; tag?: string }) => FlowResult;
  resetLab: () => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);

  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(storageKey(), JSON.stringify(state)); } catch { /* storage unavailable: run in memory */ }
    }, 120);
    return () => clearTimeout(t);
  }, [state]);

  const commit = useCallback((next: FirewallConfig, audit: AuditInput[]) => dispatch({ type: 'config/commit', next, audit }), []);
  const patchSession = useCallback((patch: Partial<LabSession>) => dispatch({ type: 'session/patch', patch }), []);
  const patchLab = useCallback((patch: Partial<LabControls>, audit?: AuditInput[]) => dispatch({ type: 'lab/patch', patch, audit }), []);
  const setProgress = useCallback((fn: (p: Progress) => Progress) => dispatch({ type: 'progress/set', fn }), []);
  const addAuditCb = useCallback((entries: AuditInput[]) => dispatch({ type: 'audit/add', entries }), []);
  const addLogsCb = useCallback((logs: Omit<LogEntry, 'id'>[]) => dispatch({ type: 'logs/add', logs }), []);
  const emit = useCallback((type: string, data: Record<string, unknown> = {}) => dispatch({ type: 'event', event: { type, data } }), []);
  const update = useCallback((fn: (s: RootState) => RootState) => dispatch({ type: 'update', fn }), []);
  const resetLab = useCallback(() => {
    try { localStorage.removeItem(storageKey()); } catch { /* ignore */ }
    dispatch({ type: 'lab/reset' });
  }, []);

  const latest = useRef(state);
  latest.current = state;
  const sendFlow = useCallback((spec: FlowSpec, opts: { at?: number; tag?: string } = {}) => {
    const { result, effects } = evaluate(latest.current, spec, { at: opts.at });
    dispatch({
      type: 'update',
      fn: (s) => pushEvent(applyEffects(s, effects), {
        type: 'test',
        data: {
          tag: opts.tag ?? '', from: spec.from, to: spec.to, proto: spec.proto, port: spec.port, app: spec.app ?? '', payload: spec.payload ?? 'clean',
          verdict: result.verdict, ok: result.ok, rule: result.rule, nat: result.nat, egress: result.egress, at: result.ts, reason: result.reason,
          user: spec.user ?? null, servedBy: result.servedBy, cert: result.certIssuer ?? '', security: result.security?.kind ?? '',
        },
      }),
    });
    return result;
  }, []);

  const value = useMemo<StoreValue>(() => ({
    state, config: state.config, session: state.session, lab: state.lab, progress: state.progress,
    commit, patchSession, patchLab, setProgress, addAudit: addAuditCb, addLogs: addLogsCb, emit, update, sendFlow, resetLab,
  }), [state, commit, patchSession, patchLab, setProgress, addAuditCb, addLogsCb, emit, update, sendFlow, resetLab]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error('useStore must be used inside <StoreProvider>');
  return v;
}
