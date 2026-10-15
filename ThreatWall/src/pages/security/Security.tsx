import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { AppAction, AppCategory, SecurityConfig } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Note, Row, Section, Tick, Toggle } from '../../components/ui';
import { APPS, SIGNATURES } from '../../engine/world';
import { licensed, saveAppControl, saveBotnet, saveGav, saveIps, validateExclusion } from '../../services/securityService';
import { LicenseNote } from './ContentFilter';

function ActionBar({ dirty, onCancel, onAccept }: { dirty: boolean; onCancel: () => void; onAccept: () => void }) {
  return (
    <div className="tw-actionbar">
      <button className="tw-btn" disabled={!dirty} onClick={onCancel}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="accept" disabled={!dirty} onClick={onAccept}>Accept</button>
    </div>
  );
}

/** Local edit buffer for a slice of security config, re-synced when the saved value changes. */
function useBuffer<T>(saved: T): [T, (v: T) => void, boolean, () => void] {
  const [v, setV] = useState(saved);
  const json = JSON.stringify(saved);
  useEffect(() => { setV(JSON.parse(json)); }, [json]);
  return [v, setV, JSON.stringify(v) !== json, () => setV(JSON.parse(json))];
}

/* ---------- Summary ---------- */
export function SecuritySummaryPage() {
  const { config } = useStore();
  const s = config.security;
  const rows: [string, string, boolean][] = [
    ['Gateway Anti-Virus', 'gav', s.gav.enabled], ['Intrusion Prevention', 'ips', s.ips.enabled], ['Application Control', 'app', s.appControl.enabled],
    ['Content Filtering Service', 'cfs', s.cfs.enabled], ['DPI-SSL (client)', 'dpissl', s.dpiSsl.clientEnabled], ['Botnet Filter', 'botnet', s.botnet.enabled],
  ];
  return (
    <div className="tw-page">
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Security services summary">
          <thead><tr><th>Service</th><th>Licensed</th><th>Enabled</th><th>Zones with the service on</th></tr></thead>
          <tbody>
            {rows.map(([n, id, on]) => {
              const key = id === 'gav' ? 'gatewayAv' : id === 'ips' ? 'ips' : id === 'app' ? 'appControl' : null;
              return <tr key={id}><td><b>{n}</b></td><td>{licensed(config, id) ? <span className="tw-pill ok">Licensed</span> : <span className="tw-pill bad">Not licensed</span>}</td><td><Tick on={on} /></td>
                <td>{key ? config.zones.filter((z) => z[key as 'ips']).map((z) => z.name).join(', ') : '—'}</td></tr>;
            })}
          </tbody>
        </table>
      </div>
      <Note kind="info">A service only acts when it is licensed, enabled globally, enabled on the zones the traffic crosses, and — for encrypted traffic — able to see inside (DPI-SSL, task 3.2).</Note>
    </div>
  );
}

/* ---------- App Control ---------- */
const CATS: AppCategory[] = ['P2P', 'Proxy-Access', 'Social Networking', 'Streaming Media', 'Business Apps'];
export function AppControlPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [ac, setAc, dirty, reset] = useBuffer(config.security.appControl);
  useDraft('appcontrol', ac);
  return (
    <div className="tw-page">
      <LicenseNote id="app" name="Application Control" />
      <Section title="App Control Global Settings">
        <div className="tw-form">
          <Row label="Enable App Control"><Toggle id="ac-enable" checked={ac.enabled} onChange={(v) => setAc({ ...ac, enabled: v })} label="Enable App Control" /></Row>
          <Row label="Log all detected applications"><Toggle checked={ac.logAll} onChange={(v) => setAc({ ...ac, logAll: v })} label="Log all" /></Row>
        </div>
      </Section>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Application categories">
          <thead><tr><th>Category</th><th>Example applications</th><th>Action</th></tr></thead>
          <tbody>
            {CATS.map((c) => (
              <tr key={c} data-guide={`appcat:${c}`}>
                <td><b>{c}</b></td><td>{APPS.filter((a) => a.category === c).map((a) => a.name).join(', ')}</td>
                <td>
                  <select className="tw-select" id={`ac-${c.replace(/\s/g, '-')}`} value={ac.categories[c]} onChange={(e) => setAc({ ...ac, categories: { ...ac.categories, [c]: e.target.value as AppAction } })} aria-label={`${c} action`}>
                    <option value="none">No action</option><option value="log">Log</option><option value="block">Block and log</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note kind="info">App Control acts only on zones with “App Control” enabled (OBJECT › Zones). LAN and WAN have it on by default.</Note>
      <ActionBar dirty={dirty} onCancel={reset} onAccept={() => { const r = saveAppControl(config, ac); commit(r.next, r.audit); toast('App Control settings saved.'); }} />
    </div>
  );
}

/* ---------- Intrusion Prevention ---------- */
export function IpsPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [ips, setIps, dirty, reset] = useBuffer(config.security.ips);
  const [sid, setSid] = useState('');
  const [sidErr, setSidErr] = useState('');
  useDraft('ips', ips);
  const lvl = (k: 'high' | 'medium' | 'low', f: 'prevent' | 'detect') => (
    <Toggle id={`ips-${k}-${f}`} checked={ips[k][f]} onChange={(v) => setIps({ ...ips, [k]: { ...ips[k], [f]: v } })} label={`${k} ${f}`} />
  );
  return (
    <div className="tw-page">
      <LicenseNote id="ips" name="Intrusion Prevention" />
      <Section title="IPS Global Settings">
        <div className="tw-form">
          <Row label="Enable IPS"><Toggle id="ips-enable" checked={ips.enabled} onChange={(v) => setIps({ ...ips, enabled: v })} label="Enable IPS" /></Row>
        </div>
      </Section>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Signature groups">
          <thead><tr><th>Signature Group</th><th>Prevent All</th><th>Detect All</th></tr></thead>
          <tbody>
            {(['high', 'medium', 'low'] as const).map((k) => <tr key={k}><td><b>{k[0].toUpperCase() + k.slice(1)} Priority Attacks</b></td><td>{lvl(k, 'prevent')}</td><td>{lvl(k, 'detect')}</td></tr>)}
          </tbody>
        </table>
      </div>
      <Section title="Signature exclusions">
        <div className="tw-form">
          <Row label="Exclude signature ID" htmlFor="ips-sid" error={sidErr} hint="Exclude only after confirming a false positive from the IPS log. Never exclude a whole category.">
            <input id="ips-sid" className="tw-input mono" style={{ width: 100 }} value={sid} onChange={(e) => setSid(e.target.value.trim())} />
            <button className="tw-btn" data-guide="ips-add-excl" onClick={() => { const er = validateExclusion({ ...config, security: { ...config.security, ips } }, sid); setSidErr(er); if (!er) { setIps({ ...ips, exclusions: [...ips.exclusions, Number(sid)] }); setSid(''); } }}><Plus size={13} /> Add</button>
          </Row>
          <Row label="Excluded"><span className="val">{ips.exclusions.length ? ips.exclusions.map((x) => (
            <span key={x} className="tw-pill muted" style={{ marginRight: 6 }}>{x} {SIGNATURES[x]?.name} <button className="tw-rowbtn" aria-label={`Remove ${x}`} onClick={() => setIps({ ...ips, exclusions: ips.exclusions.filter((y) => y !== x) })}><Trash2 size={11} /></button></span>
          )) : 'none'}</span></Row>
        </div>
      </Section>
      <ActionBar dirty={dirty} onCancel={reset} onAccept={() => { const r = saveIps(config, ips); commit(r.next, r.audit); toast('IPS settings saved.'); }} />
    </div>
  );
}

/* ---------- Gateway Anti-Virus ---------- */
export function GavPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [gav, setGav, dirty, reset] = useBuffer<SecurityConfig['gav']>(config.security.gav);
  useDraft('gav', gav);
  return (
    <div className="tw-page">
      <LicenseNote id="gav" name="Gateway Anti-Virus" />
      <Section title="Gateway AV Global Settings">
        <div className="tw-form"><Row label="Enable Gateway Anti-Virus"><Toggle id="gav-enable" checked={gav.enabled} onChange={(v) => setGav({ ...gav, enabled: v })} label="Enable Gateway Anti-Virus" /></Row></div>
      </Section>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Protocols inspected">
          <thead><tr><th>Protocol</th><th>Inbound inspection</th><th>Outbound inspection</th></tr></thead>
          <tbody>
            {Object.entries(gav.protocols).map(([p, v]) => (
              <tr key={p}><td><b>{p}</b></td>
                <td><Toggle id={`gav-${p.replace(/\W/g, '')}-in`} checked={v.inbound} onChange={(x) => setGav({ ...gav, protocols: { ...gav.protocols, [p]: { ...v, inbound: x } } })} label={`${p} inbound`} /></td>
                <td><Toggle checked={v.outbound} onChange={(x) => setGav({ ...gav, protocols: { ...gav.protocols, [p]: { ...v, outbound: x } } })} label={`${p} outbound`} /></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note kind="info">The lab’s test file is EICAR — a harmless, industry-standard string every anti-virus engine detects. No real malware is used.</Note>
      <ActionBar dirty={dirty} onCancel={reset} onAccept={() => { const r = saveGav(config, gav); commit(r.next, r.audit); toast('Gateway Anti-Virus settings saved.'); }} />
    </div>
  );
}

/* ---------- Botnet ---------- */
export function BotnetPage() {
  const { config, commit } = useStore();
  return (
    <div className="tw-page">
      <LicenseNote id="botnet" name="Botnet Filter" />
      <Section title="Botnet Filter">
        <div className="tw-form">
          <Row label="Block connections to/from Botnet Command and Control Servers" hint="Uses a reputation list of known C2 addresses. The lab list is synthetic.">
            <Toggle id="botnet-enable" checked={config.security.botnet.enabled} onChange={(v) => { const r = saveBotnet(config, v); commit(r.next, r.audit); }} label="Enable botnet filter" />
          </Row>
        </div>
      </Section>
    </div>
  );
}
