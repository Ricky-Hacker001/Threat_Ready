import { useState, type FormEvent } from 'react';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { Section } from '../../components/ui';
import { fwLookup, fwPing, fwTrace } from '../../engine/diag';

type Tool = 'ping' | 'dns' | 'trace';
const LABEL: Record<Tool, string> = { ping: 'Ping', dns: 'DNS Name Lookup', trace: 'Traceroute' };

export function DiagnosticsPage() {
  const { state, emit } = useStore();
  const [tool, setTool] = useState<Tool>('ping');
  const [target, setTarget] = useState('');
  const [out, setOut] = useState<string[]>([]);
  useDraft('diag', { tool, target });
  const run = (e: FormEvent) => {
    e.preventDefault();
    const t = target.trim();
    if (!t) return;
    const r = tool === 'ping' ? fwPing(state, t) : tool === 'dns' ? fwLookup(state, t) : fwTrace(state, t);
    setOut((o) => [...o, `> ${LABEL[tool].toLowerCase()} ${t}`, ...r.lines, ''].slice(-200));
    emit('diag', { tool, target: t, ok: r.ok, ip: r.ip, reason: r.reason });
  };
  return (
    <div className="tw-page">
      <Section title="Diagnostic Tools">
        <form className="tw-form" onSubmit={run}>
          <label htmlFor="dg-tool">Diagnostic Tool</label>
          <select id="dg-tool" data-guide="diag-tool" className="tw-select" value={tool} onChange={(e) => setTool(e.target.value as Tool)}>
            {(Object.keys(LABEL) as Tool[]).map((t) => <option key={t} value={t}>{LABEL[t]}</option>)}
          </select>
          <label htmlFor="dg-target">{tool === 'dns' ? 'Look up name' : 'IP Address or Name'}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="dg-target" data-guide="diag-target" className="tw-input mono wide" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={tool === 'dns' ? 'www.search.example' : '203.0.113.9'} />
            <button className="tw-btn tw-btn-primary" data-guide="diag-go" type="submit">Go</button>
          </div>
        </form>
      </Section>
      <div className="tw-term" style={{ margin: '0 14px', minHeight: 180, maxHeight: 360 }} aria-live="polite">{out.length ? out.join('\n') : 'Results appear here. These tools run from the firewall itself, not from your PC.'}</div>
    </div>
  );
}
