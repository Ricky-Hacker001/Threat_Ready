import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

type Kind = 'ok' | 'warn' | 'bad' | 'info';
interface Toast { id: number; kind: Kind; text: ReactNode }

const Ctx = createContext<(text: ReactNode, kind?: Kind) => void>(() => {});
const ICON = { ok: CheckCircle2, warn: AlertTriangle, bad: XCircle, info: Info };
const COLOR = { ok: 'var(--tw-ok)', warn: 'var(--tw-warn)', bad: 'var(--tw-bad)', info: 'var(--tw-info)' };

let seq = 0;
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: ReactNode, kind: Kind = 'ok') => {
    const id = ++seq;
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'bad' ? 7000 : 4200);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="tw-toasts" role="status" aria-live="polite">
        {items.map((t) => {
          const Icon = ICON[t.kind];
          return (
            <div key={t.id} className={`tw-toast ${t.kind}`}>
              <Icon size={16} color={COLOR[t.kind]} style={{ flex: 'none', marginTop: 1 }} />
              <div>{t.text}</div>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
