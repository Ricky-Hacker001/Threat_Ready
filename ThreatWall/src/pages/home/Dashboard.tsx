import { useEffect, useMemo, useState } from 'react';
import { ArrowUp, Check, Menu, X } from 'lucide-react';
import './dashboard.css';
import { useStore } from '../../state/store';
import { Tabs, SimTag } from '../../components/ui';
import { ShieldMark } from '../../components/Logo';
import type { FirewallConfig, NetInterface } from '../../state/types';

type Tab = 'device' | 'summary' | 'security' | 'network';

function uptime(ms: number) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d} Days ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Deterministic, smooth-looking load series (simulated) so the chart does not jump on re-render. */
function series(seed: number, n: number, base: number, amp: number) {
  return Array.from({ length: n }, (_, i) => {
    const t = seed + i;
    const v = base + amp * (Math.sin(t / 3.1) * 0.5 + Math.sin(t / 1.7) * 0.3 + Math.sin(t * 1.3) * 0.2);
    return Math.max(1, Math.min(99, v));
  });
}

function ifState(i: NetInterface): 'up' | 'down' | 'off' {
  if (!i.enabled || i.zone === null) return 'off';
  return i.link === 'up' ? 'up' : 'down';
}

export function DashboardPage() {
  const { config, state } = useStore();
  const [tab, setTab] = useState<Tab>('device');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 2000); return () => clearInterval(t); }, []);

  const sys = config.system;
  const wan = config.interfaces.find((i) => i.zone === 'WAN' && i.enabled);
  const lastChange = state.audit.find((a) => a.category !== 'Session');
  const configured = config.interfaces.filter((i) => i.zone !== null);
  const seed = Math.floor(now / 2000);
  const cpu = useMemo(() => series(seed, 40, 18, 14), [seed]);
  const dp = useMemo(() => series(seed + 99, 40, 9, 7), [seed]);
  const activeConns = configured.filter((i) => ifState(i) === 'up').length * 141 + (seed % 37);

  return (
    <div className="tw-dash">
      <Tabs<Tab> tabs={[{ id: 'device', label: 'Device' }, { id: 'summary', label: 'Summary' }, { id: 'security', label: 'Security Services' }, { id: 'network', label: 'Network' }]} value={tab} onChange={setTab} />

      {tab === 'device' && (
        <>
          <FrontPanel config={config} />
          <div className="tw-dash-grid">
            <section className="tw-dpanel" aria-labelledby="dg-general">
              <h3 id="dg-general">General</h3>
              <dl className="tw-kv">
                <dt>Name</dt><dd>{sys.hostname}</dd>
                <dt>Model</dt><dd>{sys.model}</dd>
                <dt>Serial Number</dt><dd className="mono">{sys.serial}</dd>
                <dt>Authentication Code</dt><dd className="mono">{sys.authCode}</dd>
                <dt>Firmware Version</dt><dd>{sys.firmware}</dd>
                <dt>ROM Version</dt><dd>{sys.romVersion}</dd>
                <dt>System Time</dt><dd>{new Date(now).toLocaleString('en-GB', { timeZone: sys.timezone })} ({sys.timezone})</dd>
                <dt>Up Time</dt><dd>{uptime(now - sys.bootedAt)}</dd>
                <dt>Primary WAN</dt><dd>{wan ? `${wan.name} (${wan.ip})` : 'Not configured'}</dd>
                <dt>Registration</dt><dd>{config.licensing.registered ? `Registered to ${config.licensing.account}` : 'Not registered'}</dd>
                <dt>Last Modified By</dt><dd>{lastChange ? `${lastChange.user} · ${new Date(lastChange.ts).toLocaleString()}` : 'Unmodified since reset'}</dd>
              </dl>
            </section>

            <section className="tw-dpanel" aria-labelledby="dg-status">
              <h3 id="dg-status">System Status <span className="sp" /><SimTag /></h3>
              <Spark data={cpu} label="Management Plane" color="#f2c14e" />
              <Spark data={dp} label="Data Plane" color="#8cc63f" />
            </section>

            <section className="tw-dpanel" aria-labelledby="dg-usage">
              <h3 id="dg-usage">System Usage</h3>
              <div className="tw-big"><div className="n">{(activeConns * 0.37).toFixed(2)} Kbps</div><div className="l">Bandwidth</div></div>
              <div className="tw-big"><div className="n">{activeConns}</div><div className="l">Active Connections</div></div>
            </section>

            <section className="tw-dpanel" aria-labelledby="dg-net" style={{ gridRow: 'span 2' }}>
              <h3 id="dg-net">Network Interfaces <span className="sp" /><Menu size={14} color="#9aa4af" /></h3>
              {config.interfaces.map((i) => {
                const st = ifState(i);
                return (
                  <div className="tw-ifrow" key={i.name}>
                    <span className="lbl">[{i.zone ?? 'Unassigned'}] {i.name}</span>
                    <span className={`tw-ifstat ${st}`} title={st === 'up' ? 'Link up' : st === 'down' ? 'No link' : 'Unassigned or disabled'}>
                      {st === 'up' ? <ArrowUp size={13} /> : st === 'down' ? <X size={12} /> : null}
                    </span>
                    <span className="mono">{i.ip}</span>
                  </div>
                );
              })}
            </section>

            <section className="tw-dpanel" aria-labelledby="dg-ha">
              <h3 id="dg-ha">High Availability</h3>
              <dl className="tw-kv">
                <dt>Mode</dt><dd>{config.ha.mode === 'none' ? 'None' : 'Active / Standby'}</dd>
                <dt>Device State</dt><dd>{config.ha.mode === 'none' ? 'Not Configured' : state.lab.haPower.primary ? 'Active' : 'Down'}</dd>
                <dt>Peer Device State</dt><dd>{config.ha.mode === 'none' ? 'Not Configured' : !state.lab.haPower.secondary ? 'Down' : config.ha.synced ? (state.lab.haPower.primary ? 'Standby' : 'Active') : 'Not synchronized'}</dd>
                <dt>Stateful Sync</dt><dd>{config.ha.mode === 'none' ? 'Not Configured' : config.ha.statefulSync ? 'Enabled' : 'Disabled'}</dd>
              </dl>
            </section>

            <section className="tw-dpanel" aria-labelledby="dg-svc" style={{ gridColumn: 'span 2' }}>
              <h3 id="dg-svc">Services</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
                {config.licensing.services.map((s) => (
                  <div className="tw-svc" key={s.id}>
                    <span className="lbl">{s.name}</span>
                    <span className={`tw-ifstat ${s.status === 'licensed' ? 'up' : 'off'}`}>{s.status === 'licensed' ? <Check size={12} /> : null}</span>
                    <span>{s.status === 'licensed' ? 'Licensed' : 'Not licensed'}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}

      {tab === 'summary' && (
        <div className="tw-dash-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          {[
            ['Configured interfaces', configured.length],
            ['Zones', config.zones.length],
            ['Configuration changes', state.audit.filter((a) => a.category !== 'Session').length],
            ['Local backups', config.backups.length],
          ].map(([l, n]) => (
            <section className="tw-dpanel" key={l as string}><div className="tw-big"><div className="n">{n}</div><div className="l">{l}</div></div></section>
          ))}
          <section className="tw-dpanel" style={{ gridColumn: '1 / -1' }}>
            <h3>Recent configuration changes</h3>
            {state.audit.filter((a) => a.category !== 'Session').slice(0, 8).map((a) => (
              <div key={a.id} className="tw-ifrow" style={{ gridTemplateColumns: '170px 1fr' }}>
                <span className="lbl">{new Date(a.ts).toLocaleString()}</span><span>{a.action} — <span className="muted">{a.detail}</span></span>
              </div>
            ))}
            {state.audit.every((a) => a.category === 'Session') ? <p className="muted">No changes yet.</p> : null}
          </section>
        </div>
      )}

      {tab === 'security' && (
        <div className="tw-dash-grid" style={{ gridTemplateColumns: '1fr' }}>
          <section className="tw-dpanel">
            <h3>Security Services</h3>
            {!config.licensing.registered ? <p style={{ color: '#f2c14e' }}>The appliance is not registered, so no security service is active (task 0.5).</p> : null}
            {config.licensing.services.map((s) => (
              <div className="tw-svc" key={s.id} style={{ gridTemplateColumns: '260px 20px 1fr' }}>
                <span className="lbl">{s.name}</span>
                <span className={`tw-ifstat ${s.status === 'licensed' ? 'up' : 'off'}`}>{s.status === 'licensed' ? <Check size={12} /> : null}</span>
                <span>{s.status === 'licensed' ? `Licensed until ${s.expires}` : 'Not licensed'}</span>
              </div>
            ))}
          </section>
        </div>
      )}

      {tab === 'network' && (
        <div className="tw-dash-grid" style={{ gridTemplateColumns: '1fr' }}>
          <section className="tw-dpanel">
            <h3>Zones and interfaces</h3>
            {config.zones.map((z) => {
              const m = config.interfaces.filter((i) => i.zone === z.name);
              return (
                <div key={z.name} className="tw-ifrow" style={{ gridTemplateColumns: '160px 1fr' }}>
                  <span className="lbl">{z.name} ({z.securityType})</span>
                  <span>{m.length ? m.map((i) => `${i.name} ${i.ip}/${i.mask}`).join(' · ') : <span className="muted">no interfaces</span>}</span>
                </div>
              );
            })}
          </section>
        </div>
      )}
    </div>
  );
}

function Spark({ data, label, color }: { data: number[]; label: string; color: string }) {
  const w = 400, h = 70;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / 100) * h}`).join(' ');
  const last = Math.round(data[data.length - 1]);
  return (
    <div style={{ marginBottom: 10 }}>
      <svg className="tw-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${label} CPU ${last}%`}>
        {[0, 50, 100].map((g) => <line key={g} x1="0" x2={w} y1={h - (g / 100) * h} y2={h - (g / 100) * h} stroke="#2e343b" strokeWidth="1" />)}
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="tw-spark-lbl"><span>-80 sec</span><b style={{ color: '#d7dce2' }}>{label} · {last}%</b><span>Now</span></div>
    </div>
  );
}

function FrontPanel({ config }: { config: FirewallConfig }) {
  const phys = config.interfaces.filter((i) => i.kind === 'physical');
  const mgmt = config.interfaces.find((i) => i.kind === 'mgmt');
  const cls = (i?: NetInterface) => (i && i.enabled && i.link === 'up' && i.zone ? 'up' : '');
  return (
    <div className="tw-front" role="img" aria-label="Appliance front panel. Green ports have link.">
      <div className="id">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ShieldMark size={26} /><span style={{ fontWeight: 700, letterSpacing: '.04em' }}>THREATWALL</span></div>
        <div className="model">{config.system.model}</div>
      </div>
      <div className="tw-leds">
        <span><i className="on" /> Power</span>
        <span><i className={config.system.setupComplete ? 'on' : 'warn'} /> Status</span>
        <span><i className={config.licensing.registered ? 'on' : ''} /> Licensed</span>
      </div>
      <div className="tw-ports">
        <div className="tw-port-group">
          <span className="cap">MGMT</span>
          <div className={`tw-port ${cls(mgmt)}`}><span className="jack" /><span>MGMT</span></div>
        </div>
        <div className="tw-port-group">
          <span className="cap">1 GE</span>
          <div className="tw-port-row">
            {phys.map((p) => <div key={p.name} className={`tw-port ${cls(p)}`} title={`${p.name}: ${p.zone ?? 'Unassigned'}`}><span className="jack" /><span>{p.name}</span></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
