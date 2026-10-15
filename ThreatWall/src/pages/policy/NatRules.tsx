import { useState } from 'react';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { NatRule } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Confirm, Dialog, Note, Row, Toggle } from '../../components/ui';
import { AddressSelect, IfaceSelect, ServiceSelect } from '../../components/pickers';
import { blankNat, builtInNat, deleteNat, saveNat, toggleNat, validateNat } from '../../services/policyService';

export function NatRulesPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [view, setView] = useState<'all' | 'custom' | 'default'>('all');
  const [edit, setEdit] = useState<{ n: NatRule; originalId: string | null } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const defaults = view === 'custom' ? [] : builtInNat(config);
  const custom = view === 'default' ? [] : config.natRules;
  let idx = 0;
  return (
    <div className="tw-page">
      <div className="tw-toolbar">
        <select className="tw-select" value={view} onChange={(e) => setView(e.target.value as typeof view)} aria-label="View" style={{ width: 150 }}>
          <option value="all">View: All</option><option value="custom">View: Custom</option><option value="default">View: Default</option>
        </select>
        <span className="muted">NAT policies are checked top-down; custom policies are evaluated before the defaults.</span>
        <span className="spacer" />
        <button className="tw-tool" data-guide="add-nat" onClick={() => setEdit({ n: blankNat(), originalId: null })}><Plus size={15} /> Add</button>
        <button className="tw-tool"><RefreshCw size={14} /> Refresh</button>
      </div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="NAT policies">
          <thead><tr><th>#</th><th>Name</th><th>Original Source</th><th>Translated Source</th><th>Original Destination</th><th>Translated Destination</th><th>Original Service</th><th>Translated Service</th><th>Inbound</th><th>Outbound</th><th>Hits</th><th>Enable</th><th>Class</th><th>Configure</th></tr></thead>
          <tbody>
            {custom.map((n) => (
              <tr key={n.id} className={n.enabled ? '' : 'disabled'} data-guide={`nat:${n.name}`}>
                <td>{++idx}</td><td><b>{n.name}</b></td><td>{n.origSrc}</td><td>{n.transSrc}</td><td>{n.origDst}</td><td>{n.transDst}</td><td>{n.origSvc}</td><td>{n.transSvc}</td><td>{n.inIface}</td><td>{n.outIface}</td>
                <td className="mono">{n.hits}</td>
                <td><Toggle checked={n.enabled} label={`Enable ${n.name}`} onChange={(v) => { const r = toggleNat(config, n.id, v); commit(r.next, r.audit); }} /></td>
                <td>Custom</td>
                <td>
                  <button className="tw-rowbtn" aria-label={`Edit ${n.name}`} onClick={() => setEdit({ n: { ...n }, originalId: n.id })}><Pencil size={15} /></button>
                  <button className="tw-rowbtn" aria-label={`Delete ${n.name}`} onClick={() => setDel(n.id)}><Trash2 size={15} /></button>
                </td>
              </tr>
            ))}
            {defaults.map((n) => (
              <tr key={n.id} className={n.enabled ? '' : 'disabled'} data-guide={`nat:${n.name}`}>
                <td>{++idx}</td><td><b>{n.name}</b></td><td>{n.origSrc}</td><td>{n.transSrc}</td><td>{n.origDst}</td><td>{n.transDst}</td><td>{n.origSvc}</td><td>{n.transSvc}</td><td>{n.inIface}</td><td>{n.outIface}</td>
                <td className="mono">—</td>
                <td><Toggle checked={n.enabled} label={`Enable ${n.name}`} onChange={(v) => { const r = toggleNat(config, n.id, v); commit(r.next, r.audit); }} /></td>
                <td>Default</td><td><span className="muted">—</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="tw-table-foot">Default outbound NAT is created automatically for each WAN interface with a static address: private LAN/DMZ sources leave as that interface’s public IP.</div>
      {edit && <NatDialog initial={edit.n} originalId={edit.originalId} onClose={() => setEdit(null)} onSave={(n) => { const r = saveNat(config, n, edit.originalId); commit(r.next, r.audit); toast(<>NAT policy <b>{n.name}</b> saved.</>); setEdit(null); }} />}
      {del && <Confirm title="Delete NAT policy" danger confirmLabel="Delete" message="Delete this NAT policy?" onCancel={() => setDel(null)} onConfirm={() => { const r = deleteNat(config, del); commit(r.next, r.audit); setDel(null); }} />}
    </div>
  );
}

function NatDialog({ initial, originalId, onClose, onSave }: { initial: NatRule; originalId: string | null; onClose: () => void; onSave: (n: NatRule) => void }) {
  const { config } = useStore();
  const [n, setN] = useState(initial);
  const [tried, setTried] = useState(false);
  useDraft('nat', n);
  const errors = validateNat(config, n, originalId);
  const e = tried ? errors : {};
  const set = <K extends keyof NatRule>(k: K, v: NatRule[K]) => setN((p) => ({ ...p, [k]: v }));
  return (
    <Dialog title={originalId ? `Edit NAT Policy - ${initial.name}` : 'Add NAT Policy'} onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="nat-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(n); }}>{originalId ? 'Save' : 'Add'}</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Name" htmlFor="nat-name" error={e.name}><input id="nat-name" className={`tw-input wide${e.name ? ' invalid' : ''}`} value={n.name} onChange={(ev) => set('name', ev.target.value)} /></Row>
        <Row label="Original Source" htmlFor="nat-os" error={e.origSrc}><AddressSelect cfg={config} id="nat-os" value={n.origSrc} onChange={(v) => set('origSrc', v)} /></Row>
        <Row label="Translated Source" htmlFor="nat-ts" error={e.transSrc}><AddressSelect cfg={config} id="nat-ts" value={n.transSrc} onChange={(v) => set('transSrc', v)} any="Original" /></Row>
        <Row label="Original Destination" htmlFor="nat-od" error={e.origDst}><AddressSelect cfg={config} id="nat-od" value={n.origDst} onChange={(v) => set('origDst', v)} invalid={!!e.origDst} /></Row>
        <Row label="Translated Destination" htmlFor="nat-td" error={e.transDst}><AddressSelect cfg={config} id="nat-td" value={n.transDst} onChange={(v) => set('transDst', v)} any="Original" invalid={!!e.transDst} /></Row>
        <Row label="Original Service" htmlFor="nat-osv" error={e.origSvc}><ServiceSelect cfg={config} id="nat-osv" value={n.origSvc} onChange={(v) => set('origSvc', v)} /></Row>
        <Row label="Translated Service" htmlFor="nat-tsv" error={e.transSvc}><ServiceSelect cfg={config} id="nat-tsv" value={n.transSvc} onChange={(v) => set('transSvc', v)} any="Original" /></Row>
        <Row label="Inbound Interface" htmlFor="nat-in" error={e.inIface}><IfaceSelect cfg={config} id="nat-in" value={n.inIface} onChange={(v) => set('inIface', v)} any="Any" /></Row>
        <Row label="Outbound Interface" htmlFor="nat-out" error={e.outIface}><IfaceSelect cfg={config} id="nat-out" value={n.outIface} onChange={(v) => set('outIface', v)} any="Any" /></Row>
        <Row label="Comment" htmlFor="nat-comment"><input id="nat-comment" className="tw-input wide" value={n.comment} onChange={(ev) => set('comment', ev.target.value)} /></Row>
        <Row label="Enable NAT Policy"><Toggle checked={n.enabled} onChange={(v) => set('enabled', v)} label="Enable NAT policy" /></Row>
      </div>
      <Note kind="info">A NAT policy only translates addresses. Traffic still needs an access rule that allows it.</Note>
    </Dialog>
  );
}
