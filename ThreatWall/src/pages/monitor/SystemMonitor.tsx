import { useStore } from '../../state/store';
import { Section } from '../../components/ui';

/** Simple real-time view built from the lab's own logs (what was allowed/dropped recently, per category). */
export function SystemMonitorPage() {
  const { state, config } = useStore();
  const now = Date.now();
  const recent = state.logs.filter((l) => now - l.ts < 3_600_000);
  const by = (k: (l: (typeof recent)[number]) => string) => Object.entries(recent.reduce<Record<string, number>>((a, l) => { a[k(l)] = (a[k(l)] ?? 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]);
  const Bars = ({ data }: { data: [string, number][] }) => {
    const max = Math.max(1, ...data.map(([, v]) => v));
    return <div className="tw-bars">{data.length ? data.map(([k, v]) => <div key={k} className="tw-bar"><span>{k}</span><div><i style={{ width: `${(v / max) * 100}%` }} /></div><b>{v}</b></div>) : <span className="muted">No traffic in the last hour. Send some from Lab Tools.</span>}</div>;
  };
  const ifaces = config.interfaces.filter((i) => i.zone && i.kind !== 'mgmt');
  return (
    <div className="tw-page">
      <Section title="Events in the last hour, by action"><Bars data={by((l) => l.action)} /></Section>
      <Section title="By category"><Bars data={by((l) => l.category)} /></Section>
      <Section title="Top sources"><Bars data={by((l) => l.src || '—').slice(0, 8)} /></Section>
      <Section title="Interfaces"><Bars data={ifaces.map((i) => [`${i.name} (${i.zone})`, recent.filter((l) => l.notes.includes(i.name) || l.message.includes(i.name)).length] as [string, number])} /></Section>
    </div>
  );
}
