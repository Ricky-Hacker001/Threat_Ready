import { useMemo, useState } from 'react';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { NetInterface } from '../../state/types';
import { useStore } from '../../state/store';
import { useToast } from '../../components/Toast';
import { Confirm, Dialog, Note, Row, SimTag, Tabs, Toggle } from '../../components/ui';
import { InterfaceDialog } from './InterfaceDialog';
import { useDraft } from '../../state/ui';
import {
  addVlan, applyInterface, assignmentLabel, deleteVlan, newVlanDraft, sessionImpact, statusLabel, validateVlanTag,
} from '../../services/interfaceService';

type Tab = 'settings' | 'stats';
type Pending = { draft: NetInterface; isNew: boolean; warnings: string[]; impact: ReturnType<typeof sessionImpact> };

export function InterfacesPage() {
  const { config, session, commit, patchSession } = useStore();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('settings');
  const [ipv, setIpv] = useState<'v4' | 'v6'>('v4');
  const [editing, setEditing] = useState<{ iface: NetInterface; isNew: boolean } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const doCommit = (p: Pending) => {
    const { next, audit } = p.isNew ? addVlan(config, p.draft) : applyInterface(config, p.draft);
    commit(next, audit);
    setEditing(null);
    setPending(null);
    toast(<><b>{p.draft.name}</b> saved.</>);
    if (p.impact) patchSession({ disconnected: p.impact });
  };

  const requestSave = (draft: NetInterface, warnings: string[], isNew: boolean) => {
    const before = config.interfaces.find((i) => i.name === draft.name);
    const impact = !isNew && before ? sessionImpact(session, before, draft) : null;
    const p: Pending = { draft, isNew, warnings, impact };
    if (warnings.length || impact) setPending(p);
    else doCommit(p);
  };

  const toggleEnabled = (i: NetInterface, enabled: boolean) => requestSave({ ...i, enabled }, [], false);

  return (
    <div className="tw-page">
      <Tabs<Tab> tabs={[{ id: 'settings', label: 'Interface Settings' }, { id: 'stats', label: 'Traffic Statistics' }]} value={tab} onChange={setTab} />
      <Tabs<'v4' | 'v6'> variant="sub" tabs={[{ id: 'v4', label: 'IPv4' }, { id: 'v6', label: 'IPv6' }]} value={ipv} onChange={setIpv} />

      {ipv === 'v6' ? (
        <Note kind="info">IPv6 is turned off for this lab appliance (DEVICE | Settings &gt; Administration). All learning-track tasks use IPv4.</Note>
      ) : tab === 'settings' ? (
        <>
          <div className="tw-toolbar">
            <span className="muted">Physical ports, VLAN sub-interfaces and the out-of-band MGMT port.</span>
            <span className="spacer" />
            <button className="tw-tool" data-guide="add-iface" onClick={() => setAddOpen(true)}><Plus size={15} /> Add Interface</button>
            <button className="tw-tool" onClick={() => setTick((t) => t + 1)}><RefreshCw size={14} /> Refresh</button>
          </div>
          <div className="tw-table-wrap">
            <table className="tw-table" aria-label="Interfaces">
              <thead>
                <tr>
                  <th>Name</th><th>Zone</th><th>IP Address</th><th>Subnet Mask</th><th>IP Assignment</th>
                  <th>Status</th><th>Enabled</th><th>Comment</th><th style={{ width: 70 }}>Configure</th>
                </tr>
              </thead>
              <tbody>
                {config.interfaces.map((i) => (
                  <tr key={i.name}>
                    <td style={{ paddingLeft: i.kind === 'vlan' ? 26 : 10 }}>{i.name}</td>
                    <td>{i.zone ?? 'Unassigned'}</td>
                    <td className="mono">{i.ip}</td>
                    <td className="mono">{i.mask}</td>
                    <td>{assignmentLabel(i)}</td>
                    <td>{statusLabel(i)}</td>
                    <td>
                      {i.kind === 'mgmt'
                        ? <span className="muted">—</span>
                        : <Toggle checked={i.enabled} onChange={(v) => toggleEnabled(i, v)} label={`${i.enabled ? 'Disable' : 'Enable'} ${i.name}`} />}
                    </td>
                    <td>{i.comment || 'N/A'}</td>
                    <td>
                      <button className="tw-rowbtn" data-guide={`edit:${i.name}`} aria-label={`Edit ${i.name}`} title="Edit" onClick={() => setEditing({ iface: i, isNew: false })}><Pencil size={15} /></button>
                      {i.kind === 'vlan' ? <button className="tw-rowbtn" aria-label={`Delete ${i.name}`} title="Delete" onClick={() => setToDelete(i.name)}><Trash2 size={15} /></button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="tw-table-foot">Total: {config.interfaces.length} item(s)</div>
        </>
      ) : (
        <TrafficStats key={tick} />
      )}

      {editing && (
        <InterfaceDialog
          iface={editing.iface}
          isNew={editing.isNew}
          onCancel={() => setEditing(null)}
          onSave={(d, w) => requestSave(d, w, editing.isNew)}
        />
      )}

      {pending && (
        <Confirm
          title={pending.impact ? 'This change will disconnect you' : 'Review warnings'}
          confirmLabel={pending.impact ? 'Save and disconnect' : 'Save anyway'}
          danger={!!pending.impact}
          onCancel={() => setPending(null)}
          onConfirm={() => doCommit(pending)}
          message={<>
            {pending.impact ? <p style={{ marginTop: 0 }}><b>{pending.impact.reason}</b> You are managing the firewall through {session.connectedVia} at {session.connectedIp}, so your browser session will drop when you save.</p> : null}
            {pending.warnings.map((w) => <p key={w} style={{ margin: '6px 0' }}>• {w}</p>)}
          </>}
        />
      )}

      {addOpen && <AddInterfaceDialog onCancel={() => setAddOpen(false)} onNext={(draft) => { setAddOpen(false); setEditing({ iface: draft, isNew: true }); }} />}

      {toDelete && (
        <Confirm
          title={`Delete ${toDelete}?`}
          danger
          confirmLabel="Delete"
          message="The VLAN sub-interface and its address are removed. Rules and DHCP scopes that use it will stop matching."
          onCancel={() => setToDelete(null)}
          onConfirm={() => { const r = deleteVlan(config, toDelete); commit(r.next, r.audit); toast(`${toDelete} deleted.`); setToDelete(null); }}
        />
      )}
    </div>
  );
}

function AddInterfaceDialog({ onCancel, onNext }: { onCancel: () => void; onNext: (d: NetInterface) => void }) {
  const { config } = useStore();
  const parents = config.interfaces.filter((i) => i.kind === 'physical');
  const [parent, setParent] = useState('X0');
  const [tag, setTag] = useState('');
  const [tried, setTried] = useState(false);
  const err = validateVlanTag(config, parent, tag);
  useDraft('vlan', { parent, tag });
  const p = parents.find((x) => x.name === parent);
  return (
    <Dialog title="Add Interface - Virtual Interface (VLAN)" onClose={onCancel} size="sm" footer={<>
      <button className="tw-btn" onClick={onCancel}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="vlan-next" onClick={() => { setTried(true); if (!err) onNext(newVlanDraft(config, parent, Number(tag))); }}>Next</button>
    </>}>
      <div className="tw-form" style={{ gridTemplateColumns: '150px 1fr', paddingTop: 14 }}>
        <Row label="Parent Interface" htmlFor="vl-parent">
          <select id="vl-parent" className="tw-select" value={parent} onChange={(e) => setParent(e.target.value)}>
            {parents.map((x) => <option key={x.name}>{x.name}</option>)}
          </select>
        </Row>
        <Row label="VLAN Tag" htmlFor="vl-tag" error={tried ? err : undefined} hint="Lab VLANs: 10 Staff, 20 Finance, 30 Guest">
          <input id="vl-tag" className={`tw-input${tried && err ? ' invalid' : ''}`} value={tag} onChange={(e) => setTag(e.target.value.trim())} inputMode="numeric" />
        </Row>
      </div>
      {p && (p.zone === null || !p.enabled) ? <Note kind="warn">{parent} is {p.zone === null ? 'unassigned' : 'shut down'}. A VLAN on it will not pass traffic until the parent is configured, and the switch port must be an 802.1Q trunk.</Note> : null}
    </Dialog>
  );
}

function TrafficStats() {
  const { config } = useStore();
  const up = (Date.now() - config.system.bootedAt) / 1000;
  const rows = useMemo(() => config.interfaces.map((i, n) => {
    const active = i.enabled && i.link === 'up' && i.zone !== null;
    const rate = active ? [1830, 1410, 620, 410][n % 4] : 0;
    const rx = Math.floor(up * rate);
    const tx = Math.floor(up * rate * 0.83);
    return { name: i.name, rx, tx, rxB: rx * 612, txB: tx * 701, err: 0 };
  }), [config.interfaces, up]);
  const fmt = (n: number) => n.toLocaleString('en-IN');
  return (
    <>
      <div className="tw-toolbar"><SimTag>Simulated counters</SimTag><span className="muted">Counters accumulate since the appliance booted.</span></div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Interface traffic statistics">
          <thead><tr><th>Name</th><th className="num">Rx Unicast Packets</th><th className="num">Rx Bytes</th><th className="num">Tx Unicast Packets</th><th className="num">Tx Bytes</th><th className="num">Errors</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}><td>{r.name}</td><td className="num">{fmt(r.rx)}</td><td className="num">{fmt(r.rxB)}</td><td className="num">{fmt(r.tx)}</td><td className="num">{fmt(r.txB)}</td><td className="num">{r.err}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
