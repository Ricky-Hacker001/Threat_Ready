import { useState } from 'react';
import { Plus, RefreshCw, ShieldPlus, Trash2 } from 'lucide-react';
import type { AntiSpoofEntry, AntiSpoofIface, StaticArp } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Confirm, Dialog, Note, Row, Tabs, Tick, Toggle } from '../../components/ui';
import { IfaceSelect } from '../../components/pickers';
import { arpTable, hasAddress } from '../../engine/network';
import {
  blankSpoofEntry, deleteArp, deleteSpoofEntries, ifaceSpoof, normMac, saveArp, saveSpoofEntry, saveSpoofIface, validateArp, validateSpoofEntry,
} from '../../services/networkService';

/* ============================== ARP ============================== */

export function ArpPage() {
  const { state, config, commit, emit } = useStore();
  const toast = useToast();
  const [add, setAdd] = useState<StaticArp | null>(null);
  const [q, setQ] = useState('');
  const rows = arpTable(state).filter((r) => !q || r.ip.includes(q) || r.mac.includes(q.toLowerCase()) || r.vendor.toLowerCase().includes(q.toLowerCase()));
  const dup = new Map<string, number>();
  arpTable(state).forEach((r) => dup.set(r.mac, (dup.get(r.mac) ?? 0) + 1));
  return (
    <div className="tw-page">
      <div className="tw-toolbar">
        <div className="tw-search"><input placeholder="Filter IP, MAC or vendor..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter ARP cache" /></div>
        <span className="spacer" />
        <button className="tw-tool" onClick={() => setAdd({ id: '', ip: '', mac: '', iface: 'X0', publish: false })}><Plus size={15} /> Add Static Entry</button>
        <button className="tw-tool" data-guide="arp-flush" onClick={() => { emit('arp', { action: 'flush' }); toast('ARP cache flushed. Entries are re-learned as hosts talk.'); }}><RefreshCw size={14} /> Flush ARP Cache</button>
      </div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="ARP cache">
          <thead><tr><th>IP Address</th><th>MAC Address</th><th>Vendor</th><th>Interface</th><th>Type</th><th>Timeout</th><th>Configure</th></tr></thead>
          <tbody>
            {rows.map((r, n) => {
              const st = config.staticArp.find((x) => x.ip === r.ip && x.iface === r.iface);
              return (
                <tr key={`${r.iface}-${r.ip}-${n}`} data-guide={`arp:${r.ip}`} className={r.vendor === 'UNKNOWN' ? 'warn' : ''}>
                  <td className="mono">{r.ip}</td><td className="mono">{r.mac}</td><td>{r.vendor || '—'}</td><td>{r.iface}</td><td>{r.type}</td><td>{r.timeout}</td>
                  <td>{st ? <button className="tw-rowbtn" aria-label="Delete static entry" onClick={() => { const x = deleteArp(config, st.id); commit(x.next, x.audit); }}><Trash2 size={15} /></button> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Note kind="info">An ARP entry maps an IP to the MAC that answered for it. If two devices claim the same IP, the last one to answer wins — that is how an address conflict (or spoofing) breaks a legitimate PC.</Note>
      {add && <ArpDialog initial={add} onClose={() => setAdd(null)} onSave={(a) => { const r = saveArp(config, a); commit(r.next, r.audit); setAdd(null); }} />}
    </div>
  );
}

function ArpDialog({ initial, onClose, onSave }: { initial: StaticArp; onClose: () => void; onSave: (a: StaticArp) => void }) {
  const { config } = useStore();
  const [a, setA] = useState(initial);
  const [tried, setTried] = useState(false);
  const errors = validateArp(config, a);
  const e = tried ? errors : {};
  return (
    <Dialog title="Add Static ARP" size="sm" onClose={onClose} footer={<><button className="tw-btn" onClick={onClose}>Cancel</button><button className="tw-btn tw-btn-primary" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(a); }}>OK</button></>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="IP Address" htmlFor="arp-ip" error={e.ip}><input id="arp-ip" className="tw-input mono" value={a.ip} onChange={(ev) => setA({ ...a, ip: ev.target.value.trim() })} /></Row>
        <Row label="Interface" htmlFor="arp-if" error={e.iface}><IfaceSelect cfg={config} id="arp-if" value={a.iface} onChange={(v) => setA({ ...a, iface: v })} onlyAddressed /></Row>
        <Row label="MAC Address" htmlFor="arp-mac" error={e.mac}><input id="arp-mac" className="tw-input mono" value={a.mac} onChange={(ev) => setA({ ...a, mac: ev.target.value.trim() })} /></Row>
        <Row label="Publish Entry"><Toggle checked={a.publish} onChange={(v) => setA({ ...a, publish: v })} label="Publish entry" /></Row>
      </div>
    </Dialog>
  );
}

/* ============================== MAC-IP Anti-Spoof ============================== */

const SPOOF_FLAGS: { key: keyof AntiSpoofIface; label: string; help: string }[] = [
  { key: 'enabled', label: 'Enable', help: 'Turn anti-spoof checking on for this interface.' },
  { key: 'staticArp', label: 'Static ARP', help: 'Trust static ARP entries as known pairs.' },
  { key: 'dhcpServer', label: 'DHCP Server', help: 'Trust pairs the firewall itself handed out by DHCP.' },
  { key: 'arpLock', label: 'ARP Lock', help: 'Pin cached pairs in the ARP table so a rogue ARP reply cannot overwrite them.' },
  { key: 'arpWatch', label: 'ARP Watch', help: 'Send ARP probes to verify pairs.' },
  { key: 'enforceIngress', label: 'Enforce (Ingress)', help: 'Drop traffic from pairs not in the cache.' },
  { key: 'spoofDetection', label: 'Spoof Detection', help: 'Log and list spoofing attempts.' },
  { key: 'allowMgmt', label: 'Allow Management', help: 'Let unknown hosts still reach the firewall’s own management (keeps you from locking yourself out).' },
];

type STab = 'settings' | 'cache' | 'detected';

export function AntiSpoofPage() {
  const { state, config, commit } = useStore();
  const toast = useToast();
  const [tab, setTab] = useState<STab>('settings');
  const [editIf, setEditIf] = useState<string | null>(null);
  const [add, setAdd] = useState<AntiSpoofEntry | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [del, setDel] = useState(false);
  const ifaces = config.interfaces.filter(hasAddress).filter((i) => i.zone !== 'WAN');
  const detected = state.logs.filter((l) => /anti-spoof/i.test(l.message)).slice(0, 50);

  return (
    <div className="tw-page">
      <Tabs<STab> tabs={[{ id: 'settings', label: 'Settings' }, { id: 'cache', label: 'Anti-Spoof Cache' }, { id: 'detected', label: 'Spoof Detected List' }]} value={tab} onChange={setTab} />
      {tab === 'settings' && (
        <div className="tw-table-wrap">
          <table className="tw-table" aria-label="Anti-spoof interface settings">
            <thead><tr><th>Interface</th><th>Zone</th>{SPOOF_FLAGS.map((f) => <th key={f.key}>{f.label}</th>)}<th>Configure</th></tr></thead>
            <tbody>
              {ifaces.map((i) => {
                const s = ifaceSpoof(config, i.name);
                return (
                  <tr key={i.name}>
                    <td><b>{i.name}</b></td><td>{i.zone}</td>
                    {SPOOF_FLAGS.map((f) => <td key={f.key}><Tick on={s[f.key]} /></td>)}
                    <td><button className="tw-rowbtn" data-guide={`spoof-edit:${i.name}`} aria-label={`Configure ${i.name}`} onClick={() => setEditIf(i.name)}><ShieldPlus size={15} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'cache' && (
        <>
          <div className="tw-toolbar">
            <span className="muted">Known-good IP/MAC pairs. Blacklisted MACs are dropped on every interface with anti-spoof enabled.</span>
            <span className="spacer" />
            <button className="tw-tool" data-guide="spoof-add" onClick={() => setAdd(blankSpoofEntry())}><Plus size={15} /> Add</button>
            <button className="tw-tool" disabled={!sel.size} onClick={() => setDel(true)}><Trash2 size={14} /> Delete</button>
          </div>
          <div className="tw-table-wrap">
            <table className="tw-table" aria-label="Anti-spoof cache">
              <thead><tr><th className="cb" /><th>IP Address</th><th>MAC Address</th><th>Interface</th><th>Router</th><th>Blacklisted</th><th>Comment</th></tr></thead>
              <tbody>
                {config.antiSpoof.cache.map((c) => (
                  <tr key={c.id} className={c.blacklisted ? 'warn' : ''} data-guide={`spoof:${c.mac}`}>
                    <td className="cb"><input type="checkbox" checked={sel.has(c.id)} onChange={(e) => setSel((s) => { const x = new Set(s); if (e.target.checked) x.add(c.id); else x.delete(c.id); return x; })} aria-label={`Select ${c.ip}`} /></td>
                    <td className="mono">{c.ip}</td><td className="mono">{c.mac}</td><td>{c.iface}</td><td><Tick on={c.router} /></td>
                    <td><Toggle checked={c.blacklisted} label={`Blacklist ${c.mac}`} onChange={(v) => { const r = saveSpoofEntry(config, { ...c, blacklisted: v }); commit(r.next, r.audit); }} /></td>
                    <td>{c.comment}</td>
                  </tr>
                ))}
                {!config.antiSpoof.cache.length ? <tr><td colSpan={7} className="muted">Empty. Add the trusted pairs (ADMIN-PC, HR-PC, FIN-PC) from the asset register.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      )}
      {tab === 'detected' && (
        <div className="tw-table-wrap">
          <table className="tw-table" aria-label="Spoof detected list">
            <thead><tr><th>Time</th><th>Source IP</th><th>Event</th><th>Notes</th></tr></thead>
            <tbody>
              {detected.map((l) => <tr key={l.id}><td>{new Date(l.ts).toLocaleTimeString()}</td><td className="mono">{l.src}</td><td>{l.message}</td><td>{l.notes}</td></tr>)}
              {!detected.length ? <tr><td colSpan={4} className="muted">Nothing detected yet. Spoof Detection must be on, and the suspect host must send traffic.</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}

      {editIf && <SpoofIfaceDialog name={editIf} onClose={() => setEditIf(null)} onSave={(s) => { const r = saveSpoofIface(config, editIf, s); commit(r.next, r.audit); toast(<>Anti-spoof settings for <b>{editIf}</b> saved.</>); setEditIf(null); }} />}
      {add && <SpoofEntryDialog initial={add} onClose={() => setAdd(null)} onSave={(en) => { const r = saveSpoofEntry(config, en); commit(r.next, r.audit); toast('Cache entry added.'); setAdd(null); }} />}
      {del && <Confirm title="Delete entries" danger confirmLabel="Delete" message={`Delete ${sel.size} cache entr${sel.size === 1 ? 'y' : 'ies'}?`} onCancel={() => setDel(false)} onConfirm={() => { const r = deleteSpoofEntries(config, [...sel]); commit(r.next, r.audit); setSel(new Set()); setDel(false); }} />}
    </div>
  );
}

function SpoofIfaceDialog({ name, onClose, onSave }: { name: string; onClose: () => void; onSave: (s: AntiSpoofIface) => void }) {
  const { config } = useStore();
  const [s, setS] = useState(() => ifaceSpoof(config, name));
  useDraft('spoofif', { iface: name, ...s });
  return (
    <Dialog title={`MAC-IP Anti-Spoof Settings - ${name}`} onClose={onClose} footer={<><button className="tw-btn" onClick={onClose}>Cancel</button><button className="tw-btn tw-btn-primary" data-guide="spoofif-save" onClick={() => onSave(s)}>OK</button></>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        {SPOOF_FLAGS.map((f) => (
          <Row key={f.key} label={f.label} hint={f.help}>
            <Toggle id={`as-${f.key}`} checked={s[f.key]} onChange={(v) => setS({ ...s, [f.key]: v })} label={f.label} />
          </Row>
        ))}
      </div>
      {s.enforceIngress && !s.allowMgmt ? <Note kind="bad">Enforce is on and Allow Management is off: if your own PC is not in the cache you will lose access to this GUI.</Note> : null}
    </Dialog>
  );
}

function SpoofEntryDialog({ initial, onClose, onSave }: { initial: AntiSpoofEntry; onClose: () => void; onSave: (e: AntiSpoofEntry) => void }) {
  const { config } = useStore();
  const [en, setEn] = useState(initial);
  const [tried, setTried] = useState(false);
  useDraft('spoofentry', { ...en, mac: normMac(en.mac) });
  const errors = validateSpoofEntry(config, en);
  const e = tried ? errors : {};
  return (
    <Dialog title="Add Anti-Spoof Cache Entry" size="sm" onClose={onClose} footer={<><button className="tw-btn" onClick={onClose}>Cancel</button><button className="tw-btn tw-btn-primary" data-guide="spoofentry-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(en); }}>OK</button></>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Interface" htmlFor="se-if" error={e.iface}><IfaceSelect cfg={config} id="se-if" value={en.iface} onChange={(v) => setEn({ ...en, iface: v })} onlyAddressed /></Row>
        <Row label="IP Address" htmlFor="se-ip" error={e.ip}><input id="se-ip" className={`tw-input mono${e.ip ? ' invalid' : ''}`} value={en.ip} onChange={(ev) => setEn({ ...en, ip: ev.target.value.trim() })} /></Row>
        <Row label="MAC Address" htmlFor="se-mac" error={e.mac}><input id="se-mac" className={`tw-input mono${e.mac ? ' invalid' : ''}`} value={en.mac} onChange={(ev) => setEn({ ...en, mac: ev.target.value.trim() })} /></Row>
        <Row label="Router"><Toggle checked={en.router} onChange={(v) => setEn({ ...en, router: v })} label="Router" /></Row>
        <Row label="Blacklisted"><Toggle id="se-black" checked={en.blacklisted} onChange={(v) => setEn({ ...en, blacklisted: v })} label="Blacklisted" /></Row>
        <Row label="Comment" htmlFor="se-comment"><input id="se-comment" className="tw-input wide" value={en.comment} onChange={(ev) => setEn({ ...en, comment: ev.target.value })} /></Row>
      </div>
    </Dialog>
  );
}
