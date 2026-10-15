import { useEffect, useState } from 'react';
import type { DnsSettings } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Note, Row, Section } from '../../components/ui';
import { saveDns, validateDns } from '../../services/networkService';
import { firewallDns } from '../../engine/traffic';

export function DnsPage() {
  const { state, config, commit } = useStore();
  const toast = useToast();
  const clean = (d: DnsSettings): DnsSettings => ({ mode: d.mode, servers: d.servers.map((x) => (x === '0.0.0.0' ? '' : x)) as DnsSettings['servers'] });
  const [d, setD] = useState<DnsSettings>(() => clean(config.dns));
  const [tried, setTried] = useState(false);
  useEffect(() => { setD(clean(config.dns)); }, [config.dns]);
  useDraft('dns', d);
  const errors = validateDns(d);
  const e = tried ? errors : {};
  const dirty = JSON.stringify(saveDns(config, d).next.dns) !== JSON.stringify(config.dns);
  const effective = firewallDns(state);
  return (
    <div className="tw-page">
      <Section title="DNS Settings">
        <div className="tw-form">
          <Row label="DNS Server Source">
            <div className="tw-checks" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
              <label><input type="radio" name="dns-mode" data-guide="dns-inherit" checked={d.mode === 'inherit'} onChange={() => setD({ ...d, mode: 'inherit' })} /> Inherit DNS Settings Dynamically from WAN Zone</label>
              <label><input type="radio" name="dns-mode" data-guide="dns-static" checked={d.mode === 'static'} onChange={() => setD({ ...d, mode: 'static' })} /> Specify DNS Servers Manually</label>
            </div>
          </Row>
          {d.mode === 'static' ? [0, 1, 2].map((n) => (
            <Row key={n} label={`DNS Server ${n + 1}`} htmlFor={`dns-s${n}`} error={e[`s${n}`]}>
              <input id={`dns-s${n}`} className={`tw-input mono${e[`s${n}`] ? ' invalid' : ''}`} value={d.servers[n]} onChange={(ev) => { const servers = [...d.servers] as DnsSettings['servers']; servers[n] = ev.target.value.trim(); setD({ ...d, servers }); }} />
            </Row>
          )) : null}
          <Row label="Servers in use"><span className="val mono">{effective.length ? effective.join(', ') : 'none'}</span></Row>
        </div>
      </Section>
      {!effective.length ? <Note kind="warn">The firewall has no DNS servers. It cannot resolve names for itself (updates, FQDN objects, licences) or for LAN clients that use it as their DNS proxy.</Note> : null}
      <div className="tw-actionbar">
        <button className="tw-btn" disabled={!dirty} onClick={() => setD(clean(config.dns))}>Cancel</button>
        <button className="tw-btn tw-btn-primary" data-guide="accept" disabled={!dirty} onClick={() => {
          setTried(true);
          if (Object.keys(errors).length) { toast('Fix the highlighted fields.', 'bad'); return; }
          const r = saveDns(config, d); commit(r.next, r.audit); toast('DNS settings saved.');
        }}>Accept</button>
      </div>
    </div>
  );
}
