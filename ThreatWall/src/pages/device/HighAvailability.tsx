import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { HaConfig } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Note, Row, Section, Toggle } from '../../components/ui';
import { haActiveUnit } from '../../engine/network';
import { LAB } from '../../state/baseline';
import { licensed } from '../../services/securityService';
import { LicenseNote } from '../security/ContentFilter';

function useHa(): [HaConfig, (h: HaConfig) => void, boolean, () => void] {
  const { config } = useStore();
  const json = JSON.stringify(config.ha);
  const [h, setH] = useState<HaConfig>(() => JSON.parse(json));
  useEffect(() => { setH(JSON.parse(json)); }, [json]);
  return [h, setH, JSON.stringify(h) !== json, () => setH(JSON.parse(json))];
}

function Bar({ h, dirty, reset, err }: { h: HaConfig; dirty: boolean; reset: () => void; err?: string }) {
  const { config, commit } = useStore();
  const toast = useToast();
  return (
    <div className="tw-actionbar">
      {err ? <span className="tw-err-text">{err}</span> : null}
      <button className="tw-btn" disabled={!dirty} onClick={reset}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="accept" disabled={!dirty || !!err} onClick={() => {
        commit({ ...config, ha: { ...h, synced: false } }, [{ category: 'System', action: 'High Availability settings modified', detail: `${h.mode === 'none' ? 'HA off' : `Active/Standby with ${h.secondarySerial}`}; stateful sync ${h.statefulSync ? 'on' : 'off'}; preempt ${h.preempt ? 'on' : 'off'}; monitoring ${h.monitorIfaces.join(', ') || 'none'}` }]);
        toast('HA settings saved. Synchronize the units from HA › Status.');
      }}>Accept</button>
    </div>
  );
}

export function HaSettingsPage() {
  const [h, setH, dirty, reset] = useHa();
  useDraft('ha', h);
  const err = h.mode === 'active-standby' && !/^[0-9A-F]{12}$/.test(h.secondarySerial) ? 'Enter the secondary unit’s 12-character serial number.' : undefined;
  return (
    <div className="tw-page">
      <LicenseNote id="ha" name="Stateful High Availability" />
      <Section title="High Availability Settings">
        <div className="tw-form">
          <Row label="Mode" htmlFor="ha-mode">
            <select id="ha-mode" className="tw-select" value={h.mode} onChange={(e) => setH({ ...h, mode: e.target.value as HaConfig['mode'] })}>
              <option value="none">None</option><option value="active-standby">Active / Standby</option>
            </select>
          </Row>
          <Row label="Secondary Serial Number" htmlFor="ha-serial" hint={<>From the label on the second appliance (lab value <b className="mono">{LAB.haSerial}</b>).</>}>
            <input id="ha-serial" className="tw-input mono" value={h.secondarySerial} onChange={(e) => setH({ ...h, secondarySerial: e.target.value.trim().toUpperCase() })} />
          </Row>
          <Row label="Enable Stateful Synchronization" hint="Copies the connection table so sessions survive a failover."><Toggle id="ha-stateful" checked={h.statefulSync} onChange={(v) => setH({ ...h, statefulSync: v })} label="Stateful sync" /></Row>
          <Row label="Enable Preempt Mode" hint="Primary takes back control when it returns."><Toggle id="ha-preempt" checked={h.preempt} onChange={(v) => setH({ ...h, preempt: v })} label="Preempt" /></Row>
          <Row label="HA control / data link"><span className="val">X7 (dedicated cable between the units)</span></Row>
        </div>
      </Section>
      <Bar h={h} dirty={dirty} reset={reset} err={err} />
    </div>
  );
}

export function HaMonitoringPage() {
  const { config } = useStore();
  const [h, setH, dirty, reset] = useHa();
  useDraft('ha', h);
  const ifaces = config.interfaces.filter((i) => i.zone && i.kind === 'physical');
  return (
    <div className="tw-page">
      <Section title="Physical interface monitoring">
        <div className="tw-table-wrap">
          <table className="tw-table" aria-label="HA monitored interfaces">
            <thead><tr><th>Interface</th><th>Zone</th><th>Monitor link</th></tr></thead>
            <tbody>{ifaces.map((i) => <tr key={i.name}><td><b>{i.name}</b></td><td>{i.zone}</td><td><Toggle id={`ha-mon-${i.name}`} checked={h.monitorIfaces.includes(i.name)} onChange={(v) => setH({ ...h, monitorIfaces: v ? [...h.monitorIfaces, i.name] : h.monitorIfaces.filter((x) => x !== i.name) })} label={`Monitor ${i.name}`} /></td></tr>)}</tbody>
          </table>
        </div>
      </Section>
      <Note kind="info">If a monitored link fails on the active unit, the standby takes over. Monitor the LAN and the primary WAN at least.</Note>
      <Bar h={h} dirty={dirty} reset={reset} />
    </div>
  );
}

export function HaStatusPage() {
  const { state, config, commit, lab } = useStore();
  const toast = useToast();
  const ha = config.ha;
  const active = haActiveUnit(state);
  const canSync = ha.mode === 'active-standby' && !!ha.secondarySerial && licensed(config, 'ha') && lab.haPower.secondary;
  return (
    <div className="tw-page">
      <Section title="High Availability Status">
        <div className="tw-table-wrap">
          <table className="tw-table" aria-label="HA status">
            <thead><tr><th>Unit</th><th>Serial</th><th>Power</th><th>State</th></tr></thead>
            <tbody>
              <tr><td><b>Primary</b></td><td className="mono">{config.system.serial}</td><td>{lab.haPower.primary ? 'on' : 'off'}</td><td>{active === 'primary' ? <span className="tw-pill ok">Active</span> : <span className="tw-pill bad">Down</span>}</td></tr>
              <tr><td><b>Secondary</b></td><td className="mono">{ha.secondarySerial || '—'}</td><td>{lab.haPower.secondary ? 'on' : 'off'}</td><td>{ha.mode === 'none' ? <span className="tw-pill muted">Not configured</span> : active === 'secondary' ? <span className="tw-pill ok">Active</span> : ha.synced ? <span className="tw-pill info">Standby (synced)</span> : <span className="tw-pill warn">Not synchronized</span>}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="tw-form">
          <Row label="Configuration and state sync">
            <span className="val">{ha.synced ? `Synchronized${ha.statefulSync ? ' (stateful)' : ' (stateless — sessions drop on failover)'}` : 'Not synchronized'}</span>
            <button className="tw-btn" data-guide="ha-sync" disabled={!canSync} onClick={() => {
              commit({ ...config, ha: { ...ha, synced: true } }, [{ category: 'System', action: 'HA settings synchronized', detail: `Primary ${config.system.serial} → secondary ${ha.secondarySerial}${ha.statefulSync ? ', stateful' : ''}` }]);
              toast('Settings synchronized to the secondary unit.');
            }}><RefreshCw size={13} style={{ verticalAlign: -2 }} /> Synchronize Settings</button>
          </Row>
        </div>
      </Section>
      {!canSync && ha.mode !== 'none' ? <Note kind="warn">Synchronization needs: Active/Standby mode, the secondary serial, the HA licence and the secondary powered on.</Note> : null}
    </div>
  );
}
