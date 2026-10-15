import { useMemo, useState } from 'react';
import { useDraft } from '../../state/ui';
import type { NetInterface } from '../../state/types';
import { useStore } from '../../state/store';
import { Dialog, Note, Row, Tabs, Toggle } from '../../components/ui';
import { validateInterface } from '../../services/interfaceService';
import { LAB } from '../../state/baseline';

type Tab = 'general' | 'advanced';

export function InterfaceDialog({ iface, isNew, onCancel, onSave }: {
  iface: NetInterface;
  isNew?: boolean;
  onCancel: () => void;
  onSave: (draft: NetInterface, warnings: string[]) => void;
}) {
  const { config } = useStore();
  const [d, setD] = useState<NetInterface>(() => structuredClone(iface));
  const [tab, setTab] = useState<Tab>('general');
  const [tried, setTried] = useState(false);
  useDraft('iface', d);
  const set = <K extends keyof NetInterface>(k: K, v: NetInterface[K]) => setD((p) => ({ ...p, [k]: v }));

  const zoneDef = config.zones.find((z) => z.name === d.zone);
  const isWan = d.zone === 'WAN';
  const issues = useMemo(() => validateInterface(config, d), [config, d]);
  const e = tried ? issues.errors : {};
  const vlanParent = d.kind === 'vlan' ? config.interfaces.find((i) => i.name === d.parent) : undefined;
  const parentProblem = d.kind === 'vlan' && (!vlanParent || vlanParent.zone === null || !vlanParent.enabled)
    ? `Parent interface ${d.parent} must be assigned to a zone and enabled before its VLANs pass traffic.` : '';

  const submit = () => {
    setTried(true);
    if (Object.keys(issues.errors).length) { setTab('general'); return; }
    onSave(d, issues.warnings);
  };

  const mgmtBox = (k: keyof NetInterface['mgmt'], label: string) => (
    <label><input type="checkbox" id={`if-m-${k}`} checked={d.mgmt[k]} disabled={!d.zone} onChange={(ev) => set('mgmt', { ...d.mgmt, [k]: ev.target.checked })} /> {label}</label>
  );

  return (
    <Dialog
      title={`${isNew ? 'Add Interface' : 'Edit Interface'} - ${d.name}`}
      onClose={onCancel}
      footer={<>
        <button className="tw-btn" onClick={onCancel}>Cancel</button>
        <button className="tw-btn tw-btn-primary" data-guide="iface-ok" onClick={submit}>OK</button>
      </>}
    >
      <Tabs<Tab> tabs={[{ id: 'general', label: 'General' }, { id: 'advanced', label: 'Advanced' }]} value={tab} onChange={setTab} />

      {tab === 'general' && (
        <>
          <h3 className="tw-section-title">Interface ‘{d.name}’ Settings</h3>
          <div className="tw-form">
            {d.kind === 'vlan' ? (
              <>
                <Row label="Parent Interface" htmlFor="if-parent"><span className="val mono">{d.parent}</span></Row>
                <Row label="VLAN Tag" htmlFor="if-vlan"><span className="val mono">{d.vlanId}</span></Row>
              </>
            ) : null}
            <Row label="Zone" htmlFor="if-zone" error={e.zone}>
              <select id="if-zone" className="tw-select" value={d.zone ?? ''} disabled={d.kind === 'mgmt'}
                onChange={(ev) => {
                  const z = ev.target.value || null;
                  setD((p) => ({
                    ...p,
                    zone: z,
                    mode: z === null ? 'unassigned' : p.mode === 'unassigned' ? 'static' : z !== 'WAN' && p.mode === 'dhcp' ? 'static' : p.mode,
                  }));
                }}>
                {d.kind !== 'mgmt' ? <option value="">Unassigned</option> : null}
                {config.zones.filter((z) => d.kind === 'mgmt' ? z.name === 'MGMT' : z.name !== 'MGMT').map((z) => <option key={z.name} value={z.name}>{z.name}</option>)}
              </select>
              {zoneDef ? <span className="muted">{zoneDef.securityType}</span> : null}
            </Row>

            {d.zone ? (
              <>
                <Row label="IP Assignment" htmlFor="if-mode">
                  <select id="if-mode" className="tw-select" value={d.mode} onChange={(ev) => set('mode', ev.target.value as NetInterface['mode'])}>
                    <option value="static">Static</option>
                    {isWan ? <option value="dhcp">DHCP</option> : null}
                  </select>
                </Row>
                {d.mode === 'static' ? (
                  <>
                    <Row label="IP Address" htmlFor="if-ip" error={e.ip}>
                      <input id="if-ip" className={`tw-input mono${e.ip ? ' invalid' : ''}`} value={d.ip === '0.0.0.0' ? '' : d.ip} onChange={(ev) => set('ip', ev.target.value.trim())} placeholder="0.0.0.0" />
                    </Row>
                    <Row label="Subnet Mask" htmlFor="if-mask" error={e.mask}>
                      <input id="if-mask" className={`tw-input mono${e.mask ? ' invalid' : ''}`} value={d.mask === '0.0.0.0' ? '' : d.mask} onChange={(ev) => set('mask', ev.target.value.trim())} placeholder="255.255.255.0" />
                    </Row>
                    <Row label="Default Gateway (Optional)" htmlFor="if-gw" error={e.gateway} hint={isWan ? `Lab ISP-1 gateway: ${LAB.wanGw}` : undefined}>
                      <input id="if-gw" className={`tw-input mono${e.gateway ? ' invalid' : ''}`} value={d.gateway === '0.0.0.0' ? '' : d.gateway} onChange={(ev) => set('gateway', ev.target.value.trim())} placeholder="0.0.0.0" />
                    </Row>
                    {isWan ? (
                      <>
                        {[0, 1, 2].map((n) => (
                          <Row key={n} label={`DNS Server ${n + 1}`} htmlFor={`if-dns${n}`} error={e[`dns${n}`]}>
                            <input id={`if-dns${n}`} className={`tw-input mono${e[`dns${n}`] ? ' invalid' : ''}`} value={d.dns[n] === '0.0.0.0' ? '' : d.dns[n]}
                              onChange={(ev) => { const dns = [...d.dns] as NetInterface['dns']; dns[n] = ev.target.value.trim(); set('dns', dns); }} placeholder="0.0.0.0" />
                          </Row>
                        ))}
                      </>
                    ) : null}
                  </>
                ) : (
                  <Row label="DHCP Status"><span className="val">No lease — the lab ISP assigns static addresses only.</span></Row>
                )}
                <Row label="Comment" htmlFor="if-comment">
                  <input id="if-comment" className="tw-input wide" value={d.comment} onChange={(ev) => set('comment', ev.target.value)} maxLength={64} />
                </Row>
              </>
            ) : (
              <Row label="Status"><span className="val muted">Unassigned — the port is not part of any zone and carries no traffic.</span></Row>
            )}
          </div>

          {d.zone ? (
            <>
              <h3 className="tw-section-title">Management</h3>
              <div className="tw-form">
                <Row label="Management"><div className="tw-checks">{mgmtBox('https', 'HTTPS')}{mgmtBox('ping', 'Ping')}{mgmtBox('snmp', 'SNMP')}{mgmtBox('ssh', 'SSH')}{mgmtBox('http', 'HTTP')}</div></Row>
                <Row label="User Login">
                  <div className="tw-checks">
                    <label><input type="checkbox" checked={d.userLogin.http} onChange={(ev) => set('userLogin', { ...d.userLogin, http: ev.target.checked })} /> HTTP</label>
                    <label><input type="checkbox" checked={d.userLogin.https} onChange={(ev) => set('userLogin', { ...d.userLogin, https: ev.target.checked })} /> HTTPS</label>
                  </div>
                </Row>
                <Row label="Add rule to enable redirect from HTTP to HTTPS">
                  <Toggle checked={d.httpRedirect} onChange={(v) => set('httpRedirect', v)} label="Redirect HTTP to HTTPS" />
                </Row>
              </div>
            </>
          ) : null}

          {parentProblem ? <Note kind="warn">{parentProblem}</Note> : null}
          {issues.warnings.map((w) => <Note key={w} kind="warn">{w}</Note>)}
          {tried && Object.keys(issues.errors).length ? <Note kind="bad">Fix the highlighted fields before saving.</Note> : null}
        </>
      )}

      {tab === 'advanced' && (
        <>
          <h3 className="tw-section-title">Advanced Settings</h3>
          <div className="tw-form">
            <Row label="Link Speed"><span className="val">{d.kind === 'vlan' ? 'Inherited from parent' : 'Auto Negotiate'}</span></Row>
            <Row label="MAC Address"><span className="val mono">{d.mac}</span></Row>
            {d.kind !== 'vlan' ? (
              <Row label="Shutdown Port" hint="A shut-down port has no link and carries no traffic.">
                <Toggle checked={!d.enabled} onChange={(v) => set('enabled', !v)} label="Shutdown port" />
              </Row>
            ) : null}
          </div>
        </>
      )}
    </Dialog>
  );
}
