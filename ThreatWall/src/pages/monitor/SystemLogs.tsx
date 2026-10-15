import { useState } from 'react';
import { Download, Search, Trash2 } from 'lucide-react';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import type { LogEntry } from '../../state/types';
import { hostById } from '../../engine/world';
import { localTime } from '../../engine/objects';

const CATS: (LogEntry['category'] | 'All')[] = ['All', 'Network', 'Firewall Rule', 'Security Services', 'VPN', 'User', 'System', 'High Availability', 'SD-WAN'];
const PRIO: (LogEntry['priority'] | 'All')[] = ['All', 'Alert', 'Warning', 'Notice', 'Info'];

export function SystemLogsPage() {
  const { state, config, update, emit } = useStore();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<(typeof CATS)[number]>('All');
  const [prio, setPrio] = useState<(typeof PRIO)[number]>('All');
  const [action, setAction] = useState<'All' | LogEntry['action']>('All');
  const [open, setOpen] = useState<string | null>(null);
  useDraft('logs', { q, cat, prio, action });
  const rows = state.logs.filter((l) => (cat === 'All' || l.category === cat) && (prio === 'All' || l.priority === prio) && (action === 'All' || l.action === action)
    && (!q || `${l.message} ${l.src} ${l.dst} ${l.rule} ${l.notes} ${l.proto}`.toLowerCase().includes(q.toLowerCase())));

  const exportCsv = () => {
    const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    const body = ['time,priority,category,message,source,destination,protocol,action,rule,notes', ...rows.map((l) => [new Date(l.ts).toISOString(), l.priority, l.category, l.message, l.src, l.dst, l.proto, l.action, l.rule, l.notes].map(esc).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
    const el = document.createElement('a'); el.href = url; el.download = 'threatwall-lab-system-logs.csv'; el.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    emit('export-logs', { rows: rows.length, q, cat });
  };

  return (
    <div className="tw-page">
      <div className="tw-toolbar">
        <div className="tw-search"><Search size={14} color="var(--text-3)" /><input data-guide="logs-search" placeholder="Search IP, rule, message..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search logs" /></div>
        <select className="tw-viewsel" value={cat} onChange={(e) => setCat(e.target.value as typeof cat)} aria-label="Category">{CATS.map((c) => <option key={c}>{c}</option>)}</select>
        <select className="tw-viewsel" value={prio} onChange={(e) => setPrio(e.target.value as typeof prio)} aria-label="Priority">{PRIO.map((c) => <option key={c}>{c}</option>)}</select>
        <select className="tw-viewsel" value={action} onChange={(e) => setAction(e.target.value as typeof action)} aria-label="Action">
          <option value="All">All actions</option><option value="allow">Allowed</option><option value="drop">Dropped</option><option value="block">Blocked</option><option value="info">Info</option>
        </select>
        <span className="spacer" />
        <button className="tw-tool" data-guide="logs-export" onClick={exportCsv} disabled={!rows.length}><Download size={14} /> Export</button>
        <button className="tw-tool" onClick={() => update((s) => ({ ...s, logs: [] }))}><Trash2 size={14} /> Clear</button>
      </div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="System logs">
          <thead><tr><th>#</th><th>Time</th><th>Priority</th><th>Category</th><th>Message</th><th>Source</th><th>Destination</th><th>Protocol</th><th>Action</th><th>Rule</th></tr></thead>
          <tbody>
            {rows.slice(0, 500).map((l, i) => (
              <tr key={l.id} className={`${l.priority === 'Alert' ? 'alert' : ''}${open === l.id ? ' selected' : ''}`} onClick={() => setOpen(open === l.id ? null : l.id)} style={{ cursor: 'pointer' }} data-guide={`log:${i}`}>
                <td>{i + 1}</td>
                <td className="nowrap">{localTime(l.ts, config.system.timezone).label}</td>
                <td><span className={`tw-pill ${l.priority === 'Alert' ? 'bad' : l.priority === 'Warning' ? 'warn' : 'muted'}`}>{l.priority}</span></td>
                <td>{l.category}</td>
                <td style={{ whiteSpace: 'normal', minWidth: 260 }}>{l.message}{open === l.id && l.notes ? <div className="muted" style={{ fontSize: 11.5 }}>{l.notes}{l.host ? ` · host ${hostById(l.host)?.name}` : ''}</div> : null}</td>
                <td className="mono">{l.src}</td><td className="mono">{l.dst}</td><td>{l.proto}</td>
                <td>{l.action === 'allow' ? <span className="tw-pill ok">allowed</span> : l.action === 'info' ? <span className="tw-pill muted">info</span> : <span className="tw-pill bad">{l.action === 'drop' ? 'dropped' : 'blocked'}</span>}</td>
                <td>{l.rule}</td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan={10} className="muted">No log entries match. Logs are generated when lab traffic is sent (Lab Tools › Traffic Tester or the PC console) and a rule with logging enabled, or a security service, sees it.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <div className="tw-actionbar"><span className="count">Displaying {Math.min(rows.length, 500)} of {rows.length} entries</span></div>
    </div>
  );
}
