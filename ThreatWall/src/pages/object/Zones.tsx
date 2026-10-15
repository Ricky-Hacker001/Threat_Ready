import { useState } from 'react';
import { FileText, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { Zone } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Confirm, Dialog, Note, Row, Tick, Toggle } from '../../components/ui';
import { SECURITY_TYPES, blankZone, deleteZones, membersOf, saveZone, validateZone } from '../../services/zoneService';

const FLAGS: { key: keyof Zone; label: string }[] = [
  { key: 'interfaceTrust', label: 'Interface Trust' },
  { key: 'gatewayAv', label: 'Gateway AV' },
  { key: 'antiSpyware', label: 'Anti Spyware' },
  { key: 'ips', label: 'IPS' },
  { key: 'appControl', label: 'App Control' },
  { key: 'sslControl', label: 'SSL Control' },
  { key: 'sslVpnAccess', label: 'SSL VPN Access' },
  { key: 'dpiSslClient', label: 'DPI SSL Client' },
  { key: 'dpiSslServer', label: 'DPI SSL Server' },
];

export function ZonesPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ zone: Zone; original: string | null } | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const rows = config.zones.filter((z) => z.name.toLowerCase().includes(q.toLowerCase()));

  const del = () => {
    const r = deleteZones(config, [...sel]);
    setConfirmDel(false);
    if (r.error) { toast(r.error, 'bad'); return; }
    commit(r.next!, r.audit);
    toast(`${sel.size} zone(s) deleted.`);
    setSel(new Set());
  };

  return (
    <div className="tw-page">
      <div className="tw-toolbar">
        <div className="tw-search"><Search size={14} color="var(--text-3)" /><input placeholder="Search..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search zones" /></div>
        <span className="spacer" />
        <button className="tw-tool" data-guide="add-zone" onClick={() => setEdit({ zone: blankZone(), original: null })}><Plus size={15} /> Add Zone</button>
        <button className="tw-tool" disabled={!sel.size} onClick={() => setConfirmDel(true)}><Trash2 size={14} /> Delete Zones</button>
        <button className="tw-tool" onClick={() => setQ('')}><RefreshCw size={14} /> Refresh</button>
      </div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Zones">
          <thead>
            <tr>
              <th className="cb"><input type="checkbox" aria-label="Select all custom zones" checked={sel.size > 0 && rows.filter((z) => !z.builtIn).every((z) => sel.has(z.name))}
                onChange={(e) => setSel(e.target.checked ? new Set(rows.filter((z) => !z.builtIn).map((z) => z.name)) : new Set())} /></th>
              <th>#</th><th>Name</th><th>Security Type</th><th>Member Interfaces</th>
              {FLAGS.map((f) => <th key={f.key}>{f.label}</th>)}
              <th>Comment</th><th>Configure</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((z, n) => {
              const m = membersOf(config, z.name);
              return (
                <tr key={z.name} className={sel.has(z.name) ? 'selected' : ''}>
                  <td className="cb"><input type="checkbox" aria-label={`Select ${z.name}`} disabled={z.builtIn} checked={sel.has(z.name)}
                    onChange={(e) => setSel((s) => { const x = new Set(s); if (e.target.checked) x.add(z.name); else x.delete(z.name); return x; })} /></td>
                  <td>{n + 1}</td>
                  <td>{z.name}</td>
                  <td>{z.securityType}</td>
                  <td>{m.length ? m.join(', ') : 'N/A'}</td>
                  {FLAGS.map((f) => <td key={f.key}><Tick on={z[f.key] as boolean} /></td>)}
                  <td title={z.comment || undefined}><FileText size={14} color="var(--text-3)" /></td>
                  <td><button className="tw-rowbtn" aria-label={`Edit zone ${z.name}`} onClick={() => setEdit({ zone: { ...z }, original: z.name })}><Pencil size={15} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="tw-table-foot">Total: {rows.length} item(s)</div>

      {edit && <ZoneDialog initial={edit.zone} original={edit.original} onClose={() => setEdit(null)} onSave={(z) => {
        const r = saveZone(config, z, edit.original);
        commit(r.next, r.audit);
        toast(<>Zone <b>{z.name}</b> saved.</>);
        setEdit(null);
      }} />}
      {confirmDel && <Confirm title="Delete zones" danger confirmLabel="Delete" message={`Delete ${[...sel].join(', ')}?`} onCancel={() => setConfirmDel(false)} onConfirm={del} />}
    </div>
  );
}

function ZoneDialog({ initial, original, onClose, onSave }: { initial: Zone; original: string | null; onClose: () => void; onSave: (z: Zone) => void }) {
  const { config } = useStore();
  const [z, setZ] = useState(initial);
  const [tried, setTried] = useState(false);
  const errors = validateZone(config, z, original);
  useDraft('zone', z);
  const e = tried ? errors : {};
  return (
    <Dialog title={original ? `Edit Zone - ${original}` : 'Add Zone'} onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="zone-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(z); }}>Save</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 14 }}>
        <Row label="Name" htmlFor="z-name" error={e.name}>
          <input id="z-name" className={`tw-input${e.name ? ' invalid' : ''}`} value={z.name} disabled={z.builtIn} onChange={(ev) => setZ({ ...z, name: ev.target.value.trim() })} />
        </Row>
        <Row label="Security Type" htmlFor="z-type">
          <select id="z-type" className="tw-select" value={z.securityType} disabled={z.builtIn} onChange={(ev) => setZ({ ...z, securityType: ev.target.value as Zone['securityType'] })}>
            {SECURITY_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Row>
        {FLAGS.map((f) => (
          <Row key={f.key} label={f.label}>
            <Toggle checked={z[f.key] as boolean} onChange={(v) => setZ({ ...z, [f.key]: v })} label={f.label} />
          </Row>
        ))}
        <Row label="Comment" htmlFor="z-comment">
          <input id="z-comment" className="tw-input wide" value={z.comment} onChange={(ev) => setZ({ ...z, comment: ev.target.value })} />
        </Row>
      </div>
      {z.builtIn ? <Note kind="info">Built-in zone: name and security type are fixed.</Note> : null}
      <Note kind="info">Interface Trust auto-creates allow rules between interfaces in the same zone. Security services apply only once licensed (task 0.5).</Note>
    </Dialog>
  );
}
