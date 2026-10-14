import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AvatarFallback } from './AvatarFallback';
import { StatusPill } from './StatusPill';
import { hasWebGL } from './webgl';
import './avatar.css';

export type InterviewerStatus = 'preparing' | 'asking' | 'listening' | 'evaluating' | 'paused' | 'finished';
export type FallbackReason = 'no-webgl' | 'asset-error' | 'context-lost';

export interface InterviewerStageProps {
  status: InterviewerStatus;
  /** true while the question text is streaming or being spoken aloud */
  speaking: boolean;
  /** optional 0..1 mouth-open level (e.g. from speech synthesis boundary events); if absent, synthesise lip flap while speaking */
  speechLevel?: number;
  /** candidate is typing: listening micro-motion (small nods) */
  candidateTyping?: boolean;
  className?: string;
  /** called once if the model or WebGL fails, so the page can note text-only mode */
  onFallback?: (reason: 'no-webgl' | 'asset-error' | 'context-lost') => void;
}

// The 3D stack (three, R3F, drei, the GLB) is only fetched when WebGL is actually usable.
const InterviewerScene = lazy(() => import('./InterviewerScene'));

interface BoundaryProps {
  onError: (error: unknown) => void;
  children: ReactNode;
}

/** Catches GLB load/parse failures, chunk-load failures and render errors from the 3D tree. */
export class SceneErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The animated interviewer. Renders a WebGL scene when possible and a polished 2D fallback
 * otherwise (no WebGL, asset failure, or GPU context loss). The status pill is a polite live
 * region in both modes.
 */
export default function InterviewerStage({
  status,
  speaking,
  speechLevel,
  candidateTyping = false,
  className,
  onFallback,
}: InterviewerStageProps) {
  const [fallback, setFallback] = useState<FallbackReason | null>(() => (hasWebGL() ? null : 'no-webgl'));
  const [ready, setReady] = useState(false);
  const notified = useRef(false);
  const onFallbackRef = useRef(onFallback);
  onFallbackRef.current = onFallback;

  useEffect(() => {
    if (fallback && !notified.current) {
      notified.current = true;
      onFallbackRef.current?.(fallback);
    }
  }, [fallback]);

  const fail = useCallback((reason: FallbackReason) => setFallback((prev) => prev ?? reason), []);
  const onAssetError = useCallback(
    (error: unknown) => {
      if (import.meta.env.DEV) console.warn('[InterviewerStage] 3D interviewer unavailable, using text mode.', error);
      fail('asset-error');
    },
    [fail],
  );
  const onContextLost = useCallback(() => fail('context-lost'), [fail]);
  const onReady = useCallback(() => setReady(true), []);

  if (fallback) {
    return <AvatarFallback status={status} speaking={speaking} reason={fallback} className={className} />;
  }

  return (
    <div className={['ivw-stage', className].filter(Boolean).join(' ')} data-ready={ready} data-status={status}>
      <SceneErrorBoundary onError={onAssetError}>
        <Suspense fallback={null}>
          <InterviewerScene
            status={status}
            speaking={speaking}
            speechLevel={speechLevel}
            candidateTyping={candidateTyping}
            onReady={onReady}
            onContextLost={onContextLost}
          />
        </Suspense>
      </SceneErrorBoundary>
      {!ready && (
        <div className="ivw-loading">
          <span className="ivw-spinner" aria-hidden="true" />
          <span>Bringing your interviewer in…</span>
        </div>
      )}
      <div className="ivw-hud">
        <StatusPill status={status} speaking={speaking} />
      </div>
    </div>
  );
}
