import { Check } from 'lucide-react';

const STEPS = ['Resume', 'Job description', 'Confirm and configure'];

export function Stepper({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="steps" aria-label="Progress">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? 'done' : n === current ? 'current' : '';
        return (
          <li key={label} className={`step ${state}`} aria-current={n === current ? 'step' : undefined}>
            <span className="num">{n < current ? <Check className="icon sm" aria-hidden /> : n}</span>
            <span className="label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
