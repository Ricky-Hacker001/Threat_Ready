import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { DhcpScope, DhcpStatic } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Confirm, Dialog, Note, Row, Section, Tabs, Toggle } from '../../components/ui';
import { IfaceSelect } from '../../components/pickers';
import { leases, scopeFor } from '../../engine/network';
import { hostById } from '../../engine/world';
import {
  blankScope, blankStatic, deleteScope, deleteStatic, saveDhcpSettings, saveScope, saveStatic, validateScope, validateStatic,
} from '../../services/networkService';

type Tab = 'settings' | 'leases';

export function DhcpPage() {
  const { state, config, commit } = useStore();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('settings');
  const [edit, setEdit] = useState<{ sc: DhcpScope; originalId: string | null } | null>(null);
  const [sedit, setSedit] = useState<{ st: DhcpStatic; originalId: string | null } | null>(null);
  const [del, setDel] = useState<{ kind: 'scope' | 'static'; id: string } | null>(null);
  const ls = leases(state);

  return (
    <div className="tw-page">
      <Tabs<Tab> tabs={[{ id: 'settings', label: 'DHCP Server Settings' }, { id: 'leases', label: 'Current DHCP Leases' }]} value={tab} onChange={setTab} />
      {tab === 'settings' ? (
        <>
          <Section title="DHCPv4 Server">
            <div className="tw-form">
              <Row label="Enable DHCPv4 Server"><Toggle id="dhcp-enable" checked={config.dhcp.enabled} label="Enable DHCPv4 server" onChange={(v) => { const r = saveDhcpSettings(config, { enabled: v }); commit(r.next, r.audit); }} /></Row>
              <Row label="Enable Conflict Detection"><Toggle checked={config.dhcp.conflictDetection} label="Enable conflict detection" onChange={(v) => { const r = saveDhcpSettings(config, { conflictDetection: v }); commit(r.next, r.audit); }} /></Row>
            </div>
          </Section>
          <div className="tw-toolbar">
            <b>DHCPv4 Server Lease Scopes</b>
            <span className="spacer" />
            <button className="tw-tool" data-guide="add-scope" onClick={() => setEdit({ sc: blankScope(config), originalId: null })}><Plus size={15} /> Add Dynamic</button>
            <button className="tw-tool" data-guide="add-static" onClick={() => setSedit({ st: blankStatic(), originalId: null })}><Plus size={15} /> Add Static</button>
          </div>
          <div className="tw-table-wrap">
            <table className="tw-table" aria-label="DHCP scopes">
              <thead><tr><th>#</th><th>Type</th><th>Interface</th><th>IP Range / Address</th><th>Gateway / MAC</th><th>DNS</th><th>Lease</th><th>Status</th><th>Enable</th><th>Configure</th></tr></thead>
              <tbody>
                {config.dhcp.scopes.map((sc, n) => {
                  const iface = config.interfaces.find((i) => i.name === sc.iface);
                  const valid = iface && scopeFor(config, iface)?.id === sc.id;
                  return (
                    <tr key={sc.id} data-guide={`scope:${sc.iface}`} className={sc.enabled ? '' : 'disabled'}>
                      <td>{n + 1}</td><td>Dynamic</td><td>{sc.iface}</td><td className="mono">{sc.start} - {sc.end}</td><td className="mono">{sc.gateway}</td>
                      <td className="mono">{sc.dns.filter((d) => d && d !== '0.0.0.0').join(', ')}</td><td>{sc.leaseMin} min</td>
                      <td>{valid ? <span className="tw-pill ok">serving</span> : <span className="tw-pill bad" title={`The range is not inside ${sc.iface}'s subnet (${iface?.ip}/${iface?.mask}), or the server is off.`}>not serving</span>}</td>
                      <td><Toggle checked={sc.enabled} label="Enable scope" onChange={(v) => { const r = saveScope(config, { ...sc, enabled: v }, sc.id); commit(r.next, r.audit); }} /></td>
                      <td>
                        <button className="tw-rowbtn" data-guide={`edit-scope:${sc.iface}`} aria-label={`Edit scope ${sc.start}`} onClick={() => setEdit({ sc: { ...sc, dns: [sc.dns[0] === '0.0.0.0' ? '' : sc.dns[0], sc.dns[1] === '0.0.0.0' ? '' : sc.dns[1]] }, originalId: sc.id })}><Pencil size={15} /></button>
                        <button className="tw-rowbtn" aria-label="Delete scope" onClick={() => setDel({ kind: 'scope', id: sc.id })}><Trash2 size={15} /></button>
                      </td>
                    </tr>
                  );
                })}
                {config.dhcp.statics.map((st, n) => (
                  <tr key={st.id} className={st.enabled ? '' : 'disabled'} data-guide={`static:${st.name}`}>
                    <td>{config.dhcp.scopes.length + n + 1}</td><td>Static</td><td>{st.name}</td><td className="mono">{st.ip}</td><td className="mono">{st.mac}</td><td /><td>Infinite</td><td /><td>
                      <Toggle checked={st.enabled} label="Enable reservation" onChange={(v) => { const r = saveStatic(config, { ...st, enabled: v }, st.id); commit(r.next, r.audit); }} /></td>
                    <td>
                      <button className="tw-rowbtn" aria-label={`Edit ${st.name}`} onClick={() => setSedit({ st: { ...st }, originalId: st.id })}><Pencil size={15} /></button>
                      <button className="tw-rowbtn" aria-label={`Delete ${st.name}`} onClick={() => setDel({ kind: 'static', id: st.id })}><Trash2 size={15} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="tw-table-wrap">
          <table className="tw-table" aria-label="Current DHCP leases">
            <thead><tr><th>IP Address</th><th>MAC Address</th><th>Host</th><th>Interface</th><th>Type</th><th>Gateway</th><th>Expires</th></tr></thead>
            <tbody>
              {ls.map((l) => <tr key={l.mac} data-guide={`lease:${l.host}`}><td className="mono">{l.ip}</td><td className="mono">{l.mac}</td><td>{hostById(l.host)?.name}</td><td>{l.iface}</td><td>{l.kind === 'static' ? 'Static (reserved)' : 'Dynamic'}</td><td className="mono">{l.gateway}</td><td>{l.kind === 'static' ? 'Never' : 'in 23:59'}</td></tr>)}
              {!ls.length ? <tr><td colSpan={7} className="muted">No leases. Either no client asked, or no scope matches the interface subnet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}

      {edit && <ScopeDialog initial={edit.sc} originalId={edit.originalId} onClose={() => setEdit(null)} onSave={(sc) => { const r = saveScope(config, sc, edit.originalId); commit(r.next, r.audit); toast('DHCP scope saved.'); setEdit(null); }} />}
      {sedit && <StaticDialog initial={sedit.st} originalId={sedit.originalId} onClose={() => setSedit(null)} onSave={(st) => { const r = saveStatic(config, st, sedit.originalId); commit(r.next, r.audit); toast(<>Reservation <b>{st.name}</b> saved.</>); setSedit(null); }} />}
      {del && <Confirm title="Delete" danger confirmLabel="Delete" message="Delete this entry?" onCancel={() => setDel(null)} onConfirm={() => { const r = del.kind === 'scope' ? deleteScope(config, del.id) : deleteStatic(config, del.id); commit(r.next, r.audit); setDel(null); }} />}
    </div>
  );
}

function ScopeDialog({ initial, originalId, onClose, onSave }: { initial: DhcpScope; originalId: string | null; onClose: () => void; onSave: (sc: DhcpScope) => void }) {
  const { config } = useStore();
  const [sc, setSc] = useState(initial);
  const [tried, setTried] = useState(false);
  useDraft('scope', sc);
  const errors = validateScope(config, sc, originalId);
  const e = tried ? errors : {};
  const iface = config.interfaces.find((i) => i.name === sc.iface);
  return (
    <Dialog title={originalId ? 'Edit Dynamic Range' : 'Dynamic Range Configuration'} onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="scope-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(sc); }}>OK</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Interface" htmlFor="sc-if" error={e.iface}><IfaceSelect cfg={config} id="sc-if" value={sc.iface} onChange={(v) => setSc({ ...sc, iface: v })} onlyAddressed /></Row>
        {iface ? <Row label="Interface subnet"><span className="val mono">{iface.ip} / {iface.mask}</span></Row> : null}
        <Row label="Range Start" htmlFor="sc-start" error={e.start}><input id="sc-start" className={`tw-input mono${e.start ? ' invalid' : ''}`} value={sc.start} onChange={(ev) => setSc({ ...sc, start: ev.target.value.trim() })} /></Row>
        <Row label="Range End" htmlFor="sc-end" error={e.end}><input id="sc-end" className={`tw-input mono${e.end ? ' invalid' : ''}`} value={sc.end} onChange={(ev) => setSc({ ...sc, end: ev.target.value.trim() })} /></Row>
        <Row label="Lease Time (minutes)" htmlFor="sc-lease" error={e.leaseMin}><input id="sc-lease" className={`tw-input${e.leaseMin ? ' invalid' : ''}`} style={{ width: 100 }} value={String(sc.leaseMin)} onChange={(ev) => setSc({ ...sc, leaseMin: Number(ev.target.value.replace(/\D/g, '')) || 0 })} /></Row>
        <Row label="Default Gateway" htmlFor="sc-gw" error={e.gateway}><input id="sc-gw" className={`tw-input mono${e.gateway ? ' invalid' : ''}`} value={sc.gateway} onChange={(ev) => setSc({ ...sc, gateway: ev.target.value.trim() })} /></Row>
        <Row label="DNS Server 1" htmlFor="sc-dns0" error={e.dns0}><input id="sc-dns0" className={`tw-input mono${e.dns0 ? ' invalid' : ''}`} value={sc.dns[0]} onChange={(ev) => setSc({ ...sc, dns: [ev.target.value.trim(), sc.dns[1]] })} /></Row>
        <Row label="DNS Server 2" htmlFor="sc-dns1" error={e.dns1}><input id="sc-dns1" className={`tw-input mono${e.dns1 ? ' invalid' : ''}`} value={sc.dns[1]} onChange={(ev) => setSc({ ...sc, dns: [sc.dns[0], ev.target.value.trim()] })} /></Row>
        <Row label="Comment" htmlFor="sc-comment"><input id="sc-comment" className="tw-input wide" value={sc.comment} onChange={(ev) => setSc({ ...sc, comment: ev.target.value })} /></Row>
      </div>
      <Note kind="info">Keep a gap outside the range for static devices (servers, printers, the firewall itself).</Note>
    </Dialog>
  );
}

function StaticDialog({ initial, originalId, onClose, onSave }: { initial: DhcpStatic; originalId: string | null; onClose: () => void; onSave: (st: DhcpStatic) => void }) {
  const { config } = useStore();
  const [st, setSt] = useState(initial);
  const [tried, setTried] = useState(false);
  useDraft('static', st);
  const errors = validateStatic(config, st, originalId);
  const e = tried ? errors : {};
  return (
    <Dialog title={originalId ? 'Edit Static Entry' : 'Static Entry Configuration'} size="sm" onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="static-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(st); }}>OK</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Entry Name" htmlFor="st-name" error={e.name}><input id="st-name" className={`tw-input${e.name ? ' invalid' : ''}`} value={st.name} onChange={(ev) => setSt({ ...st, name: ev.target.value })} /></Row>
        <Row label="Static IP Address" htmlFor="st-ip" error={e.ip}><input id="st-ip" className={`tw-input mono${e.ip ? ' invalid' : ''}`} value={st.ip} onChange={(ev) => setSt({ ...st, ip: ev.target.value.trim() })} /></Row>
        <Row label="Ethernet Address (MAC)" htmlFor="st-mac" error={e.mac}><input id="st-mac" className={`tw-input mono${e.mac ? ' invalid' : ''}`} value={st.mac} onChange={(ev) => setSt({ ...st, mac: ev.target.value.trim() })} placeholder="00:1a:2b:3c:4d:50" /></Row>
      </div>
      <Note kind="info">Lab Hosts (in Lab Tools) lists each device’s MAC address, like reading it off the printer’s label.</Note>
    </Dialog>
  );
}
