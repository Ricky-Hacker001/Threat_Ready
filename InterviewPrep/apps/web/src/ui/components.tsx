import { AlertCircle, CheckCircle2, Info, X, type LucideIcon } from 'lucide-react';
import { Component, createContext, useCallback, useContext, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { ApiError, messageFor } from '../lib/api';
import { scoreTone } from '../lib/format';

const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Animates a number from 0 to `value` once it is known. Respects reduced motion. */
export function useCountUp(value: number | null | undefined, ms = 900): number | null {
  const [n, setN] = useState<number | null>(value == null ? null : prefersReducedMotion() ? value : 0);
  useEffect(() => {
    if (value == null) return setN(null);
    if (prefersReducedMotion()) return setN(value);
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      setN(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return n;
}

export function CountUp({ value, suffix }: { value: number | null | undefined; suffix?: ReactNode }) {
  const n = useCountUp(value);
  return (
    <span className="tabular">
      {n ?? '—'}
      {n != null && suffix}
    </span>
  );
}

/** Shows the catalogue message and a copyable request id (ADD §10 frontend contract). */
export function ErrorAlert({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const [copied, setCopied] = useState(false);
  const requestId = error instanceof ApiError ? error.requestId : null;
  const retryable = error instanceof ApiError ? error.retryable : true;
  return (
    <div className="alert error fade-in" role="alert">
      <AlertCircle className="icon" aria-hidden />
      <div className="stack" style={{ gap: 5, flex: 1 }}>
        <strong>{title ?? 'Something went wrong'}</strong>
        <span className="subtle">{messageFor(error)}</span>
        {requestId && (
          <span className="row" style={{ gap: 8 }}>
            <code>{requestId}</code>
            <button
              className="btn ghost sm"
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(requestId);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy reference'}
            </button>
          </span>
        )}
      </div>
      {onRetry && retryable && (
        <button className="btn sm" type="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} aria-hidden />;
}

export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card stack" aria-busy="true" aria-label="Loading">
      <Skeleton h={14} w="40%" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} h={12} w={`${90 - i * 12}%`} />
      ))}
    </div>
  );
}

export function Meter({ value, label, tone, thin }: { value: number | null; label?: ReactNode; tone?: string; thin?: boolean }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const t = tone ?? (scoreTone(value) === 'accent' ? '' : scoreTone(value));
  return (
    <div className="stack" style={{ gap: 7 }}>
      {label && (
        <div className="row between" style={{ fontSize: 13.5 }}>
          <span className="subtle">{label}</span>
          <span className="tabular" style={{ fontWeight: 650 }}>{value == null ? '—' : value}</span>
        </div>
      )}
      <div className={`meter ${t} ${thin ? 'thin' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined} aria-label={typeof label === 'string' ? label : undefined}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const ringColor = (score: number) => (score >= 70 ? 'var(--ok)' : score >= 50 ? 'var(--warn)' : 'var(--accent)');

export function ScoreRing({ score, size = 148, label = 'Overall', stroke = 11 }: { score: number; size?: number; label?: string; stroke?: number }) {
  const shown = useCountUp(score) ?? 0;
  const r = (size - stroke - 4) / 2;
  const c = 2 * Math.PI * r;
  const id = `ring-${label.replace(/\W/g, '')}`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} score ${score} out of 100`}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={ringColor(score)} stopOpacity="0.7" />
          <stop offset="100%" stopColor={ringColor(score)} />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--surface-3)" strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={`url(#${id})`}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${(c * shown) / 100} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ filter: `drop-shadow(0 0 8px ${ringColor(score)}55)` }}
      />
      <text x="50%" y="49%" textAnchor="middle" dominantBaseline="middle" fill="var(--text)" fontSize={size / 3.6} fontWeight="750" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {shown}
      </text>
      <text x="50%" y="68%" textAnchor="middle" fill="var(--text-3)" fontSize="12">
        out of 100
      </text>
    </svg>
  );
}

/** Radar chart for 3-6 category scores (0-100). Categories without a score are drawn at 0 and labelled. */
export function RadarChart({ data, size = 280 }: { data: { label: string; value: number | null }[]; size?: number }) {
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 40;
  const n = data.length;
  const pt = (i: number, v: number) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [cx + Math.cos(a) * R * (v / 100), cy + Math.sin(a) * R * (v / 100)] as const;
  };
  const poly = data.map((d, i) => pt(i, d.value ?? 0).join(',')).join(' ');
  return (
    <svg width="100%" viewBox={`-56 -6 ${size + 112} ${size + 12}`} role="img" aria-label={data.map((d) => `${d.label} ${d.value ?? 'not assessed'}`).join(', ')} style={{ maxWidth: size + 112, overflow: 'visible' }}>
      {[25, 50, 75, 100].map((lvl) => (
        <polygon key={lvl} points={data.map((_, i) => pt(i, lvl).join(',')).join(' ')} fill="none" stroke="var(--border)" strokeWidth="1" />
      ))}
      {data.map((_, i) => {
        const [x, y] = pt(i, 100);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--border)" />;
      })}
      <polygon points={poly} fill="rgba(109, 93, 252,0.22)" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" style={{ animation: 'fadeUp 0.6s var(--ease) both' }} />
      {data.map((d, i) => {
        const [x, y] = pt(i, d.value ?? 0);
        return <circle key={i} cx={x} cy={y} r="4" fill="var(--accent-strong)" stroke="var(--bg)" strokeWidth="2" />;
      })}
      {data.map((d, i) => {
        const [x, y] = pt(i, 128);
        return (
          <text key={d.label} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize="11.5" fill="var(--text-2)">
            <tspan x={x} dy="-0.5em">{d.label}</tspan>
            <tspan x={x} dy="1.25em" fill="var(--text)" fontWeight="700">{d.value ?? '—'}</tspan>
          </text>
        );
      })}
    </svg>
  );
}

export function Sparkline({ values, width = 220, height = 48 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const xy = values.map((v, i) => [(i / (values.length - 1)) * (width - 8) + 4, height - 4 - (v / 100) * (height - 8)] as const);
  const pts = xy.map((p) => p.join(',')).join(' ');
  const area = `4,${height - 2} ${pts} ${width - 4},${height - 2}`;
  return (
    <svg width={width} height={height} role="img" aria-label={`Score trend: ${values.join(', ')}`}>
      <defs>
        <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#spark)" />
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={xy[xy.length - 1]![0]} cy={xy[xy.length - 1]![1]} r="3.5" fill="var(--accent-strong)" />
    </svg>
  );
}

export function Empty({ title, children, action, icon: Icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="empty stack" style={{ alignItems: 'center' }}>
      {Icon && (
        <span className="icon-tile accent">
          <Icon className="icon lg" aria-hidden />
        </span>
      )}
      <h3>{title}</h3>
      {children && <p className="subtle" style={{ maxWidth: 460 }}>{children}</p>}
      {action}
    </div>
  );
}

/* ---------- Toasts ---------- */
type ToastTone = 'ok' | 'info' | 'error';
interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  body?: ReactNode;
}
const ToastCtx = createContext<(t: Omit<ToastItem, 'id'>) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );
  const Icon = { ok: CheckCircle2, info: Info, error: AlertCircle };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => {
          const I = Icon[t.tone];
          return (
            <div key={t.id} className={`toast ${t.tone}`} role="status">
              <I className="icon" aria-hidden />
              <div className="t-body">
                <strong>{t.title}</strong>
                {t.body && <p>{t.body}</p>}
              </div>
              <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <X className="icon sm" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

/** Route-level error boundary so one failing view never blanks the app. */
export class RouteErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('route error', error instanceof Error ? error.message : error, info.componentStack?.slice(0, 200));
  }
  render() {
    if (this.state.error) {
      return (
        <div className="page">
          <ErrorAlert error={this.state.error} title="This page failed to load" onRetry={() => this.setState({ error: null })} />
        </div>
      );
    }
    return this.props.children;
  }
}
