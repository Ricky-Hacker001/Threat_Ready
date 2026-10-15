import { useState } from 'react';
import { Download, Search } from 'lucide-react';
import { useStore } from '../../state/store';
import type { AuditCategory } from '../../state/types';

const CATS: (AuditCategory | 'All')[] = ['All', 'System', 'Network', 'Object', 'Policy', 'VPN', 'Security', 'Users', 'Session', 'Lab'];

export function AuditLogsPage() {
  const { state } = useStore();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<(typeof CATS)[number]>('All');
  const rows = state.audit.filter((a) =>
    (cat === 'All' || a.category === cat) &&
    `${a.action} ${a.detail} ${a.user}`.toLowerCase().includes(q.toLowerCase()));

  const exportCsv = () => {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const body = ['time,user,category,action,detail', ...rows.map((a) => [new Date(a.ts).toISOString(), a.user, a.category, a.action, a.detail].map(esc).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
    const el = document.createElement('a'); el.href = url; el.download = 'threatwall-lab-audit.csv'; el.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  return (
    <div className="tw-page">
      <div className="tw-toolbar">
        <div className="tw-search"><Search size={14} color="var(--text-3)" /><input placeholder="Search..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search audit log" /></div>
        <select className="tw-viewsel" value={cat} onChange={(e) => setCat(e.target.value as typeof cat)} aria-label="Category">
          {CATS.map((c) => <option key={c}>{c}</option>)}
        </select>
        <span className="spacer" />
        <button className="tw-tool" onClick={exportCsv} disabled={!rows.length}><Download size={14} /> Export</button>
      </div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Auditing logs">
          <thead><tr><th>#</th><th>Time</th><th>User</th><th>Category</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>
            {rows.map((a, i) => (
              <tr key={a.id}>
                <td>{i + 1}</td>
                <td>{new Date(a.ts).toLocaleString()}</td>
                <td>{a.user}</td>
                <td>{a.category}</td>
                <td>{a.action}</td>
                <td style={{ whiteSpace: 'normal', minWidth: 300 }}>{a.detail}</td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan={6} className="muted">No Data</td></tr> : null}
          </tbody>
        </table>
      </div>
      <div className="tw-actionbar"><span className="count">Displaying {rows.length} entries</span></div>
    </div>
  );
}
