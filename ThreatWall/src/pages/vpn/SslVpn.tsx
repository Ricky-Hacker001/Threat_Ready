import { useEffect, useState } from 'react';
import type { SslVpnConfig } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Note, Row, Section, Toggle } from '../../components/ui';
import { allAddressNames, findAddress, describeAddress } from '../../engine/objects';
import { autoRules } from '../../engine/rules';
import { saveSslVpn, validateSslVpn } from '../../services/vpnService';

function useSsl(): [SslVpnConfig, (v: SslVpnConfig) => void, boolean, () => void] {
  const { config } = useStore();
  const json = JSON.stringify(config.sslvpn);
  const clean = (v: SslVpnConfig): SslVpnConfig => ({ ...v, dns: v.dns.map((d) => (d === '0.0.0.0' ? '' : d)) as [string, string] });
  const [v, setV] = useState(() => clean(config.sslvpn));
  useEffect(() => { setV(clean(JSON.parse(json))); }, [json]);
  const dirty = JSON.stringify(saveSslVpn(config, v).next.sslvpn) !== json;
  return [v, setV, dirty, () => setV(clean(JSON.parse(json)))];
}

function Bar({ v, dirty, reset }: { v: SslVpnConfig; dirty: boolean; reset: () => void }) {
  const { config, commit } = useStore();
  const toast = useToast();
  const errors = validateSslVpn(config, v);
  return (
    <div className="tw-actionbar">
      {Object.values(errors)[0] ? <span className="tw-err-text">{Object.values(errors)[0]}</span> : null}
      <button className="tw-btn" disabled={!dirty} onClick={reset}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="accept" disabled={!dirty} onClick={() => {
        if (Object.keys(errors).length) { toast(Object.values(errors)[0], 'bad'); return; }
        const r = saveSslVpn(config, v); commit(r.next, r.audit); toast('SSL VPN settings saved.');
      }}>Accept</button>
    </div>
  );
}

export function SslVpnServerPage() {
  const { config } = useStore();
  const [v, setV, dirty, reset] = useSsl();
  useDraft('sslserver', { zones: v.zones, port: v.port, domain: v.domain });
  return (
    <div className="tw-page">
      <Section title="SSL VPN Status on Zones">
        <div className="tw-table-wrap">
          <table className="tw-table" aria-label="SSL VPN zones">
            <thead><tr><th>Zone</th><th>SSL VPN Access</th></tr></thead>
            <tbody>{config.zones.filter((z) => ['LAN', 'WAN', 'DMZ', 'WLAN'].includes(z.name)).map((z) => (
              <tr key={z.name}><td><b>{z.name}</b></td><td><Toggle id={`ssl-zone-${z.name}`} checked={!!v.zones[z.name]} onChange={(x) => setV({ ...v, zones: { ...v.zones, [z.name]: x } })} label={`SSL VPN on ${z.name}`} /></td></tr>
            ))}</tbody>
          </table>
        </div>
      </Section>
      <Section title="SSL VPN Server Settings">
        <div className="tw-form">
          <Row label="SSL VPN Port" htmlFor="ssl-port"><input id="ssl-port" className="tw-input" style={{ width: 90 }} value={String(v.port)} onChange={(e) => setV({ ...v, port: Number(e.target.value.replace(/\D/g, '')) || 0 })} /></Row>
          <Row label="Domain" htmlFor="ssl-domain"><input id="ssl-domain" className="tw-input" value={v.domain} onChange={(e) => setV({ ...v, domain: e.target.value })} /></Row>
          <Row label="Certificate"><span className="val">{config.system.certificate}</span></Row>
        </div>
      </Section>
      <Note kind="info">The portal listens on the WAN address at this port. Users still need a pool, routes and membership in SSLVPN Services before they can do anything.</Note>
      <Bar v={v} dirty={dirty} reset={reset} />
    </div>
  );
}

export function SslVpnClientPage() {
  const { config } = useStore();
  const [v, setV, dirty, reset] = useSsl();
  useDraft('sslclient', { pool: v.pool, clientRoutes: v.clientRoutes, dns: v.dns, tunnelAll: v.tunnelAll });
  const names = allAddressNames(config);
  const pool = v.pool ? findAddress(config, v.pool) : undefined;
  return (
    <div className="tw-page">
      <Section title="Default Device Profile — Network">
        <div className="tw-form">
          <Row label="Network Address IPv4 (client pool)" htmlFor="ssl-pool" hint={pool ? describeAddress(pool) : 'An SSLVPN-zone range object, e.g. SSLVPN_Pool.'}>
            <select id="ssl-pool" className="tw-select" value={v.pool} onChange={(e) => setV({ ...v, pool: e.target.value })}>
              <option value="">— select —</option>{config.addresses.filter((a) => a.type === 'range' || a.type === 'network').map((a) => <option key={a.name}>{a.name}</option>)}
            </select>
          </Row>
          <Row label="DNS Server 1" htmlFor="ssl-dns0"><input id="ssl-dns0" className="tw-input mono" value={v.dns[0]} onChange={(e) => setV({ ...v, dns: [e.target.value.trim(), v.dns[1]] })} /></Row>
          <Row label="DNS Server 2" htmlFor="ssl-dns1"><input id="ssl-dns1" className="tw-input mono" value={v.dns[1]} onChange={(e) => setV({ ...v, dns: [v.dns[0], e.target.value.trim()] })} /></Row>
          <Row label="Tunnel All Mode" hint="Sends all the client’s traffic, including internet, through the office. Off = split tunnel."><Toggle checked={v.tunnelAll} onChange={(x) => setV({ ...v, tunnelAll: x })} label="Tunnel all" /></Row>
          <Row label="Client Routes" htmlFor="ssl-routes" hint="Only these networks are reachable through the tunnel (and get auto access rules).">
            <select id="ssl-routes" multiple size={6} className="tw-select" style={{ height: 'auto' }} value={v.clientRoutes} onChange={(e) => setV({ ...v, clientRoutes: [...e.target.selectedOptions].map((o) => o.value) })}>
              {names.map((n) => <option key={n}>{n}</option>)}
            </select>
          </Row>
        </div>
      </Section>
      <Bar v={v} dirty={dirty} reset={reset} />
    </div>
  );
}

export function SslVpnStatusPage() {
  const { config, lab } = useStore();
  const pool = config.sslvpn.pool ? findAddress(config, config.sslvpn.pool) : undefined;
  const rules = autoRules(config).filter((r) => r.auto === 'sslvpn');
  return (
    <div className="tw-page">
      <Section title="Active NetExtender sessions">
        <div className="tw-table-wrap">
          <table className="tw-table" aria-label="SSL VPN sessions">
            <thead><tr><th>User</th><th>Client</th><th>Virtual IP</th><th>Routes</th></tr></thead>
            <tbody>
              {lab.remoteUserConnected ? <tr><td><b>connected</b></td><td>REMOTE-LAPTOP 192.0.2.80</td><td className="mono">{pool?.ip ?? '—'}</td><td>{config.sslvpn.tunnelAll ? 'All' : config.sslvpn.clientRoutes.join(', ')}</td></tr>
                : <tr><td colSpan={4} className="muted">No active sessions. Connect from Lab Tools › Lab Controls › NetExtender.</td></tr>}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Access rules created automatically">
        <div className="tw-table-wrap">
          <table className="tw-table" aria-label="SSL VPN auto rules">
            <thead><tr><th>Name</th><th>From</th><th>To</th><th>Source</th><th>Destination</th></tr></thead>
            <tbody>{rules.map((r) => <tr key={r.id}><td>{r.name}</td><td>{r.fromZone}</td><td>{r.toZone}</td><td>{r.src}</td><td>{r.dst}</td></tr>)}
              {!rules.length ? <tr><td colSpan={5} className="muted">None — enable SSL VPN on WAN and set a pool and client routes.</td></tr> : null}</tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
