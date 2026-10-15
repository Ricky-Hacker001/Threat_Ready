import { useState } from 'react';
import { Eye, EyeOff, FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import type { AddressObject, IpsecPolicy } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Confirm, Dialog, Note, Row, Section, Tabs, Toggle } from '../../components/ui';
import { tunnelStatus } from '../../engine/vpn';
import {
  AUTHS, DH_GROUPS, ENCS, blankPolicy, branchNames, deleteHqPolicy, hqNames, saveBranchAddress, saveBranchPolicy, saveHqPolicy, validateBranchAddress, validatePolicy,
} from '../../services/vpnService';

type Side = 'hq' | 'branch';

function StatusPill({ id }: { id: string }) {
  const { state } = useStore();
  const t = tunnelStatus(state, id);
  return t.state === 'up' ? <span className="tw-pill ok">Up</span> : t.state === 'disabled' ? <span className="tw-pill muted">Disabled</span> : <span className="tw-pill bad" title={t.reason}>Down ({t.stage})</span>;
}

/* ============================== HQ: NETWORK › IPSec VPN › Rules and Settings ============================== */
export function IpsecPage() {
  const { state, config, commit } = useStore();
  const toast = useToast();
  const [edit, setEdit] = useState<IpsecPolicy | null>(null);
  const [log, setLog] = useState<string | null>(config.ipsec.find((p) => p.kind === 'site')?.id ?? null);
  const [del, setDel] = useState<string | null>(null);
  const shown = log ? tunnelStatus(state, log) : null;
  return (
    <div className="tw-page">
      <div className="tw-toolbar">
        <span className="muted">Site-to-site policies. Both ends must agree on peer address, pre-shared key, proposals and networks.</span><span className="spacer" />
        <button className="tw-tool" data-guide="add-vpn" onClick={() => setEdit(blankPolicy())}><Plus size={15} /> Add</button>
      </div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="VPN policies">
          <thead><tr><th>#</th><th>Name</th><th>Gateway</th><th>Local</th><th>Remote</th><th>Exchange</th><th>Status</th><th>Enable</th><th>Configure</th></tr></thead>
          <tbody>
            {config.ipsec.map((p, n) => (
              <tr key={p.id} className={p.enabled ? '' : 'disabled'} data-guide={`vpn:${p.name}`}>
                <td>{n + 1}</td><td><b>{p.name}</b></td><td className="mono">{p.kind === 'group' ? '(group VPN)' : p.gateway}</td><td>{p.localNet}</td><td>{p.remoteNet}</td><td>{p.exchange === 'ikev2' ? 'IKEv2' : p.exchange === 'main' ? 'Main Mode' : 'Aggressive'}</td>
                <td>{p.kind === 'site' ? <StatusPill id={p.id} /> : <span className="muted">—</span>}</td>
                <td><Toggle checked={p.enabled} label={`Enable ${p.name}`} onChange={(v) => { const r = saveHqPolicy(config, { ...p, enabled: v }); commit(r.next, r.audit); }} /></td>
                <td>
                  {p.kind === 'site' ? <button className="tw-rowbtn" aria-label={`Show negotiation log for ${p.name}`} data-guide={`vpnlog:${p.name}`} onClick={() => setLog(p.id)}><FileText size={15} /></button> : null}
                  <button className="tw-rowbtn" aria-label={`Edit ${p.name}`} data-guide={`edit-vpn:${p.name}`} onClick={() => setEdit({ ...p })}><Pencil size={15} /></button>
                  {p.kind === 'site' ? <button className="tw-rowbtn" aria-label={`Delete ${p.name}`} onClick={() => setDel(p.id)}><Trash2 size={15} /></button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown ? (
        <Section title={`IKE negotiation log — ${config.ipsec.find((p) => p.id === log)?.name}`}>
          <div className="tw-term" data-guide="vpn-transcript" style={{ margin: '0 14px 10px' }}>{shown.transcript.join('\n') || '(no negotiation)'}{`\nResult: ${shown.state.toUpperCase()} — ${shown.reason}`}</div>
        </Section>
      ) : null}
      {edit && <PolicyDialog side="hq" initial={edit} onClose={() => setEdit(null)} onSave={(p) => { const r = saveHqPolicy(config, p); commit(r.next, r.audit); toast(<>VPN policy <b>{p.name}</b> saved.</>); setEdit(null); setLog(p.id || null); }} />}
      {del && <Confirm title="Delete VPN policy" danger confirmLabel="Delete" message="Delete this policy? The tunnel will go down." onCancel={() => setDel(null)} onConfirm={() => { const r = deleteHqPolicy(config, del); commit(r.next, r.audit); setDel(null); }} />}
    </div>
  );
}

/* ============================== Lab: Branch peer (KGI-BR-FW) ============================== */
export function BranchPeerPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const b = config.branch;
  const [edit, setEdit] = useState<IpsecPolicy | null>(null);
  const [addr, setAddr] = useState<AddressObject | null>(null);
  return (
    <div className="tw-page">
      <Note kind="info">Lab view of the <b>Branch firewall {b.hostname}</b> (WAN {b.wanIp}, LAN {b.lanIp}/24). On a real job you would log in to the second appliance; here both ends are simulated side by side.</Note>
      <Section title="Branch address objects">
        <div className="tw-toolbar"><span className="spacer" /><button className="tw-tool" data-guide="add-braddr" onClick={() => setAddr({ id: '', name: '', zone: 'VPN', type: 'network', ip: '', ip2: '255.255.255.0', fqdn: '', comment: '' })}><Plus size={15} /> Add</button></div>
        <div className="tw-table-wrap">
          <table className="tw-table" aria-label="Branch addresses">
            <thead><tr><th>Name</th><th>Network</th><th>Zone</th></tr></thead>
            <tbody>
              {[...b.addresses, ...[{ id: 'x0', name: 'X0 Subnet', ip: '192.168.20.0', ip2: b.lanMask, zone: 'LAN' }]].map((a) => <tr key={a.id}><td><b>{a.name}</b></td><td className="mono">{a.ip} / {a.ip2}</td><td>{a.zone}</td></tr>)}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Branch VPN policies">
        <div className="tw-toolbar"><span className="spacer" /><button className="tw-tool" data-guide="add-brvpn" onClick={() => setEdit(blankPolicy())}><Plus size={15} /> Add</button></div>
        <div className="tw-table-wrap">
          <table className="tw-table" aria-label="Branch VPN policies">
            <thead><tr><th>Name</th><th>Gateway</th><th>Local</th><th>Remote</th><th>P1</th><th>P2</th><th>Enable</th><th>Configure</th></tr></thead>
            <tbody>
              {b.ipsec.map((p) => (
                <tr key={p.id} data-guide={`brvpn:${p.name}`}>
                  <td><b>{p.name}</b></td><td className="mono">{p.gateway}</td><td>{p.localNet}</td><td>{p.remoteNet}</td><td>{p.p1.dh} {p.p1.enc} {p.p1.auth}</td><td>{p.p2.enc} {p.p2.auth} PFS {p.p2.pfs ? p.p2.pfsGroup : 'off'}</td>
                  <td><Toggle checked={p.enabled} label={`Enable ${p.name}`} onChange={(v) => { const r = saveBranchPolicy(config, { ...p, enabled: v }); commit(r.next, r.audit); }} /></td>
                  <td><button className="tw-rowbtn" aria-label={`Edit ${p.name}`} data-guide={`edit-brvpn:${p.name}`} onClick={() => setEdit({ ...p })}><Pencil size={15} /></button></td>
                </tr>
              ))}
              {!b.ipsec.length ? <tr><td colSpan={8} className="muted">No policy yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Section>
      {edit && <PolicyDialog side="branch" initial={edit} onClose={() => setEdit(null)} onSave={(p) => { const r = saveBranchPolicy(config, p); commit(r.next, r.audit); toast(<>Branch policy <b>{p.name}</b> saved.</>); setEdit(null); }} />}
      {addr && <BranchAddrDialog initial={addr} onClose={() => setAddr(null)} onSave={(a) => { const r = saveBranchAddress(config, a); commit(r.next, r.audit); setAddr(null); }} />}
    </div>
  );
}

function BranchAddrDialog({ initial, onClose, onSave }: { initial: AddressObject; onClose: () => void; onSave: (a: AddressObject) => void }) {
  const { config } = useStore();
  const [a, setA] = useState(initial);
  const [tried, setTried] = useState(false);
  useDraft('braddr', a);
  const errors = validateBranchAddress(config, a);
  const e = tried ? errors : {};
  return (
    <Dialog title="Branch: Add Address Object" size="sm" onClose={onClose} footer={<><button className="tw-btn" onClick={onClose}>Cancel</button><button className="tw-btn tw-btn-primary" data-guide="braddr-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(a); }}>Save</button></>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Name" htmlFor="ba-name" error={e.name}><input id="ba-name" className="tw-input" value={a.name} onChange={(ev) => setA({ ...a, name: ev.target.value })} /></Row>
        <Row label="Zone"><span className="val">VPN</span></Row>
        <Row label="Network" htmlFor="ba-ip" error={e.ip}><input id="ba-ip" className="tw-input mono" value={a.ip} onChange={(ev) => setA({ ...a, ip: ev.target.value.trim() })} /></Row>
        <Row label="Netmask" htmlFor="ba-ip2" error={e.ip2}><input id="ba-ip2" className="tw-input mono" value={a.ip2} onChange={(ev) => setA({ ...a, ip2: ev.target.value.trim() })} /></Row>
      </div>
    </Dialog>
  );
}

type PTab = 'general' | 'network' | 'proposals' | 'advanced';
function PolicyDialog({ side, initial, onClose, onSave }: { side: Side; initial: IpsecPolicy; onClose: () => void; onSave: (p: IpsecPolicy) => void }) {
  const { config } = useStore();
  const [p, setP] = useState(initial);
  const [tab, setTab] = useState<PTab>('general');
  const [confirm, setConfirm] = useState(initial.secret);
  const [show, setShow] = useState(false);
  const [tried, setTried] = useState(false);
  const names = side === 'hq' ? hqNames(config) : branchNames(config);
  const others = side === 'hq' ? config.ipsec : config.branch.ipsec;
  useDraft(side === 'hq' ? 'vpn' : 'brvpn', { ...p, secret: undefined, secretSet: p.secret.length >= 8, secretMatch: p.secret === confirm, secretHash: p.secret ? `len${p.secret.length}` : '' });
  const errors: Record<string, string> = { ...validatePolicy(p, names, others), ...(p.kind === 'site' && p.secret !== confirm ? { confirm: 'Shared secrets do not match.' } : {}) };
  const e: Record<string, string> = tried ? errors : {};
  const group = p.kind === 'group';
  const tabOf: Record<string, PTab> = { name: 'general', gateway: 'general', secret: 'general', confirm: 'general', localNet: 'network', remoteNet: 'network', p1life: 'proposals', p2life: 'proposals' };
  const sel = (id: string, v: string, opts: string[], on: (v: string) => void) => <select id={id} className="tw-select" value={v} onChange={(ev) => on(ev.target.value)}>{opts.map((o) => <option key={o}>{o}</option>)}</select>;
  return (
    <Dialog title={`${side === 'branch' ? `Branch (${config.branch.hostname}): ` : ''}${initial.name ? `Edit VPN Policy - ${initial.name}` : 'Add VPN Policy'}`} onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide={side === 'hq' ? 'vpn-save' : 'brvpn-save'} onClick={() => { setTried(true); const k = Object.keys(errors); if (k.length) { setTab(tabOf[k[0]] ?? 'general'); return; } onSave(p); }}>OK</button>
    </>}>
      <Tabs<PTab> tabs={[{ id: 'general', label: 'General' }, { id: 'network', label: 'Network' }, { id: 'proposals', label: 'Proposals' }, { id: 'advanced', label: 'Advanced' }]} value={tab} onChange={setTab} variant="sub" />
      {tab === 'general' && (
        <div className="tw-form" style={{ paddingTop: 12 }}>
          <Row label="Policy Type"><span className="val">{group ? 'GroupVPN' : 'Site to Site'}</span></Row>
          <Row label="Authentication Method"><span className="val">IKE using Preshared Secret</span></Row>
          <Row label="Name" htmlFor="vp-name" error={e.name}><input id="vp-name" className={`tw-input wide${e.name ? ' invalid' : ''}`} value={p.name} disabled={group} onChange={(ev) => setP({ ...p, name: ev.target.value })} /></Row>
          {!group && <>
            <Row label="IPsec Primary Gateway Name or Address" htmlFor="vp-gw" error={e.gateway}><input id="vp-gw" className={`tw-input mono${e.gateway ? ' invalid' : ''}`} value={p.gateway} onChange={(ev) => setP({ ...p, gateway: ev.target.value.trim() })} /></Row>
            <Row label="Shared Secret" htmlFor="vp-secret" error={e.secret} hint="Training-only secret. Never reuse a real one.">
              <input id="vp-secret" type={show ? 'text' : 'password'} autoComplete="off" className={`tw-input wide${e.secret ? ' invalid' : ''}`} value={p.secret} onChange={(ev) => setP({ ...p, secret: ev.target.value })} />
              <button className="tw-rowbtn" type="button" aria-label={show ? 'Hide secret' : 'Show secret'} onClick={() => setShow(!show)}>{show ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            </Row>
            <Row label="Confirm Shared Secret" htmlFor="vp-secret2" error={e.confirm}><input id="vp-secret2" type={show ? 'text' : 'password'} autoComplete="off" className={`tw-input wide${e.confirm ? ' invalid' : ''}`} value={confirm} onChange={(ev) => setConfirm(ev.target.value)} /></Row>
          </>}
        </div>
      )}
      {tab === 'network' && (
        <div className="tw-form" style={{ paddingTop: 12 }}>
          <Row label="Choose local network from list" htmlFor="vp-local" error={e.localNet}>
            <select id="vp-local" className={`tw-select${e.localNet ? ' invalid' : ''}`} value={p.localNet} onChange={(ev) => setP({ ...p, localNet: ev.target.value })}><option value="">— select —</option>{names.map((n) => <option key={n}>{n}</option>)}</select>
          </Row>
          <Row label="Choose destination network from list" htmlFor="vp-remote" error={e.remoteNet}>
            <select id="vp-remote" className={`tw-select${e.remoteNet ? ' invalid' : ''}`} value={p.remoteNet} onChange={(ev) => setP({ ...p, remoteNet: ev.target.value })}><option value="">— select —</option>{names.map((n) => <option key={n}>{n}</option>)}</select>
          </Row>
          <Note kind="info">Each side’s local network must equal the other side’s destination network, exactly.</Note>
        </div>
      )}
      {tab === 'proposals' && (
        <div className="tw-form" style={{ paddingTop: 12 }}>
          <h4 className="tw-subhead">IKE (Phase 1) Proposal</h4><span />
          <Row label="Exchange" htmlFor="vp-ex"><select id="vp-ex" className="tw-select" value={p.exchange} onChange={(ev) => setP({ ...p, exchange: ev.target.value as IpsecPolicy['exchange'] })}><option value="ikev2">IKEv2 Mode</option><option value="main">Main Mode</option><option value="aggressive">Aggressive Mode</option></select></Row>
          <Row label="DH Group" htmlFor="vp-dh">{sel('vp-dh', p.p1.dh, DH_GROUPS, (v) => setP({ ...p, p1: { ...p.p1, dh: v } }))}</Row>
          <Row label="Encryption" htmlFor="vp-enc1">{sel('vp-enc1', p.p1.enc, ENCS, (v) => setP({ ...p, p1: { ...p.p1, enc: v } }))}</Row>
          <Row label="Authentication" htmlFor="vp-auth1">{sel('vp-auth1', p.p1.auth, AUTHS, (v) => setP({ ...p, p1: { ...p.p1, auth: v } }))}</Row>
          <Row label="Life Time (seconds)" htmlFor="vp-life1" error={e.p1life}><input id="vp-life1" className="tw-input" style={{ width: 100 }} value={String(p.p1.life)} onChange={(ev) => setP({ ...p, p1: { ...p.p1, life: Number(ev.target.value.replace(/\D/g, '')) || 0 } })} /></Row>
          <h4 className="tw-subhead">IPsec (Phase 2) Proposal</h4><span />
          <Row label="Protocol"><span className="val">ESP</span></Row>
          <Row label="Encryption" htmlFor="vp-enc2">{sel('vp-enc2', p.p2.enc, ENCS, (v) => setP({ ...p, p2: { ...p.p2, enc: v } }))}</Row>
          <Row label="Authentication" htmlFor="vp-auth2">{sel('vp-auth2', p.p2.auth, AUTHS, (v) => setP({ ...p, p2: { ...p.p2, auth: v } }))}</Row>
          <Row label="Enable Perfect Forward Secrecy"><Toggle id="vp-pfs" checked={p.p2.pfs} onChange={(v) => setP({ ...p, p2: { ...p.p2, pfs: v } })} label="Enable PFS" /></Row>
          {p.p2.pfs ? <Row label="DH Group" htmlFor="vp-pfsg">{sel('vp-pfsg', p.p2.pfsGroup, DH_GROUPS, (v) => setP({ ...p, p2: { ...p.p2, pfsGroup: v } }))}</Row> : null}
          <Row label="Life Time (seconds)" htmlFor="vp-life2" error={e.p2life}><input id="vp-life2" className="tw-input" style={{ width: 100 }} value={String(p.p2.life)} onChange={(ev) => setP({ ...p, p2: { ...p.p2, life: Number(ev.target.value.replace(/\D/g, '')) || 0 } })} /></Row>
        </div>
      )}
      {tab === 'advanced' && (
        <div className="tw-form" style={{ paddingTop: 12 }}>
          <Row label="Enable Keep Alive"><Toggle id="vp-ka" checked={p.keepAlive} onChange={(v) => setP({ ...p, keepAlive: v })} label="Keep alive" /></Row>
          <Row label="Suppress automatic Access Rules creation for VPN Policy"><Toggle checked={p.suppressAutoRules} onChange={(v) => setP({ ...p, suppressAutoRules: v })} label="Suppress auto rules" /></Row>
          <Row label="VPN Policy bound to"><span className="val">{p.boundTo}</span></Row>
        </div>
      )}
    </Dialog>
  );
}
