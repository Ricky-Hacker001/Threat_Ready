import { useMemo, useState } from 'react';
import { Check, Circle, PartyPopper } from 'lucide-react';
import { ShieldMark } from '../components/Logo';
import { Note, Row } from '../components/ui';
import { useStore } from '../state/store';
import { useDraft } from '../state/ui';
import { hashPasswordSecure, passwordProblems } from '../lib/hash';
import { LAB } from '../state/baseline';
import {
  TIMEZONES, applySetup, validateAppliance, validateCredentials, validateWan, type SetupInput,
} from '../services/setupService';
import { cidr } from '../lib/ip';

const STEPS = ['Welcome', 'Administrator', 'Appliance', 'WAN (X1)', 'LAN (X0)', 'Summary', 'Complete'] as const;
const PW_RULES = ['At least 12 characters', 'An uppercase letter', 'A lowercase letter', 'A number', 'A symbol', 'Not the default or the username'];

export function SetupWizard({ onClose }: { onClose: () => void }) {
  const { config, session, commit } = useStore();
  const x0 = config.interfaces.find((i) => i.name === 'X0')!;
  const [step, setStep] = useState(0);
  const [touched, setTouched] = useState<Record<number, boolean>>({});
  const [f, setF] = useState<SetupInput>({
    adminUser: config.system.adminUser,
    password: '',
    confirm: '',
    hostname: config.system.hostname,
    timezone: config.system.timezone,
    wanMode: 'dhcp',
    wanIp: '',
    wanMask: '',
    wanGw: '',
    dns1: '',
    dns2: '',
  });
  const set = <K extends keyof SetupInput>(k: K, v: SetupInput[K]) => setF((p) => ({ ...p, [k]: v }));

  const issues = useMemo(() => {
    if (step === 1) return { errors: validateCredentials(f), warnings: [] as string[] };
    if (step === 2) return { errors: validateAppliance(f), warnings: [] as string[] };
    if (step === 3) return validateWan(config, f);
    return { errors: {} as Record<string, string>, warnings: [] as string[] };
  }, [step, f, config]);
  const show = touched[step] ? issues.errors : {};
  const missing = passwordProblems(f.password, f.adminUser);
  // Published for the guided task (never the password itself).
  useDraft('wizard', { step, adminUser: f.adminUser, hostname: f.hostname, timezone: f.timezone, wanMode: f.wanMode,
    pwOk: f.password.length > 0 && missing.length === 0, confirmOk: f.confirm.length > 0 && f.confirm === f.password });

  const next = async () => {
    if (Object.keys(issues.errors).length) { setTouched((t) => ({ ...t, [step]: true })); return; }
    if (step === 5) {
      const { next: cfg, audit } = applySetup(config, f, await hashPasswordSecure(f.password));
      commit(cfg, audit);
    }
    setStep((s) => s + 1);
  };

  return (
    <div className="tw-wiz-wrap">
      <div className="tw-wiz" role="region" aria-label="ThreatWall Setup Guide">
        <aside className="tw-wiz-rail">
          <div className="head"><ShieldMark size={22} /> Setup Guide</div>
          <ol>
            {STEPS.map((s, i) => (
              <li key={s} className={i < step ? 'done' : i === step ? 'cur' : ''} aria-current={i === step ? 'step' : undefined}>
                <span className="n">{i < step ? <Check size={13} /> : i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </aside>

        <div className="tw-wiz-main">
          <div className="body">
            {step === 0 && (
              <>
                <h1>Welcome to ThreatWall</h1>
                <p className="lead">This guide applies the minimum safe configuration to a factory-default appliance in one pass.</p>
                <ul style={{ lineHeight: 1.9, paddingLeft: 18, margin: 0 }}>
                  <li>Replace the default administrator password.</li>
                  <li>Name the appliance and set its time zone.</li>
                  <li>Confirm how the WAN (X1) gets its address.</li>
                  <li>Review the LAN (X0) management address you are connected to.</li>
                </ul>
                <Note kind="info">Nothing is applied until you click <b>Apply</b> on the Summary step.</Note>
              </>
            )}

            {step === 1 && (
              <>
                <h1>Administrator credentials</h1>
                <p className="lead">The factory password is public knowledge. A firewall left on it belongs to the first person who tries it.</p>
                <div className="tw-form">
                  <Row label="Administrator name" htmlFor="wz-user" error={show.adminUser}>
                    <input id="wz-user" className={`tw-input${show.adminUser ? ' invalid' : ''}`} value={f.adminUser} onChange={(e) => set('adminUser', e.target.value)} />
                  </Row>
                  <Row label="New password" htmlFor="wz-pw" error={show.password}>
                    <input id="wz-pw" data-guide="wiz-pw" type="password" className={`tw-input wide${show.password ? ' invalid' : ''}`} value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
                  </Row>
                  <span />
                  <ul className="tw-pwcheck" aria-label="Password requirements">
                    {PW_RULES.map((r) => {
                      const ok = f.password.length > 0 && !missing.includes(r);
                      return <li key={r} className={ok ? 'ok' : ''}>{ok ? <Check size={13} /> : <Circle size={11} />} {r}</li>;
                    })}
                  </ul>
                  <Row label="Confirm password" htmlFor="wz-pw2" error={show.confirm}>
                    <input id="wz-pw2" data-guide="wiz-pw2" type="password" className={`tw-input wide${show.confirm ? ' invalid' : ''}`} value={f.confirm} onChange={(e) => set('confirm', e.target.value)} autoComplete="new-password" />
                  </Row>
                </div>
                <Note kind="warn">This is a lab. Use a practice password, not one you use anywhere real.</Note>
              </>
            )}

            {step === 2 && (
              <>
                <h1>Appliance</h1>
                <p className="lead">The firewall name appears in logs and alerts, so you can tell which box raised them.</p>
                <div className="tw-form">
                  <Row label="Firewall name" htmlFor="wz-host" error={show.hostname} hint={<>Lab value: <b className="mono">{LAB.hostname}</b> (you can also set it later in task 0.7)</>}>
                    <input id="wz-host" className={`tw-input wide${show.hostname ? ' invalid' : ''}`} value={f.hostname} onChange={(e) => set('hostname', e.target.value)} />
                  </Row>
                  <Row label="Time zone" htmlFor="wz-tz">
                    <select id="wz-tz" className="tw-select wide" value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
                      {TIMEZONES.map((t) => <option key={t}>{t}</option>)}
                    </select>
                  </Row>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <h1>WAN (X1) IP configuration</h1>
                <p className="lead">How does the ISP give this firewall its internet address?</p>
                <div className="tw-form">
                  <Row label="IP assignment" htmlFor="wz-mode">
                    <select id="wz-mode" className="tw-select" value={f.wanMode} onChange={(e) => set('wanMode', e.target.value as SetupInput['wanMode'])}>
                      <option value="dhcp">DHCP (automatic)</option>
                      <option value="static">Static</option>
                    </select>
                  </Row>
                  {f.wanMode === 'static' && (
                    <>
                      <Row label="IP address" htmlFor="wz-ip" error={show.ip}>
                        <input id="wz-ip" className={`tw-input mono${show.ip ? ' invalid' : ''}`} value={f.wanIp} onChange={(e) => set('wanIp', e.target.value)} placeholder={LAB.wanIp} />
                      </Row>
                      <Row label="Subnet mask" htmlFor="wz-mask" error={show.mask}>
                        <input id="wz-mask" className={`tw-input mono${show.mask ? ' invalid' : ''}`} value={f.wanMask} onChange={(e) => set('wanMask', e.target.value)} placeholder={LAB.wanMask} />
                      </Row>
                      <Row label="Default gateway" htmlFor="wz-gw" error={show.gateway}>
                        <input id="wz-gw" className={`tw-input mono${show.gateway ? ' invalid' : ''}`} value={f.wanGw} onChange={(e) => set('wanGw', e.target.value)} placeholder={LAB.wanGw} />
                      </Row>
                      <Row label="DNS server 1" htmlFor="wz-dns1" error={show.dns0}>
                        <input id="wz-dns1" className={`tw-input mono${show.dns0 ? ' invalid' : ''}`} value={f.dns1} onChange={(e) => set('dns1', e.target.value)} placeholder={LAB.dns1} />
                      </Row>
                      <Row label="DNS server 2" htmlFor="wz-dns2" error={show.dns1}>
                        <input id="wz-dns2" className={`tw-input mono${show.dns1 ? ' invalid' : ''}`} value={f.dns2} onChange={(e) => set('dns2', e.target.value)} placeholder={LAB.dns2} />
                      </Row>
                    </>
                  )}
                </div>
                {issues.warnings.map((w) => <Note key={w} kind="warn">{w}</Note>)}
                <Note kind="info">Lab ISP-1 gives a static address: {LAB.wanIp} / {LAB.wanMask}, gateway {LAB.wanGw}. Keeping DHCP here is fine; task 1.1 sets the static values.</Note>
              </>
            )}

            {step === 4 && (
              <>
                <h1>LAN (X0) and management</h1>
                <p className="lead">You are connected to the firewall through X0. The Setup Guide leaves it unchanged.</p>
                <table className="tw-summary">
                  <tbody>
                    <tr><th>X0 address</th><td className="mono">{x0.ip} / {x0.mask} ({cidr(x0.ip, x0.mask)})</td></tr>
                    <tr><th>Zone</th><td>{x0.zone}</td></tr>
                    <tr><th>Management on X0</th><td>{Object.entries(x0.mgmt).filter(([, v]) => v).map(([k]) => k.toUpperCase()).join(', ')}</td></tr>
                    <tr><th>Your PC</th><td className="mono">{session.pc.name} {session.pc.ip} ({session.pc.mode === 'dhcp' ? 'DHCP' : 'static'})</td></tr>
                  </tbody>
                </table>
                <Note kind="warn">Task 1.1 moves X0 to {LAB.lanIp}/24. Changing the address you manage through will drop this session, so that task teaches the reconnect.</Note>
              </>
            )}

            {step === 5 && (
              <>
                <h1>Summary</h1>
                <p className="lead">Review, then apply. You will be asked to log in again with the new password.</p>
                <table className="tw-summary">
                  <tbody>
                    <tr><th>Administrator</th><td>{f.adminUser} · new password set ({f.password.length} characters)</td></tr>
                    <tr><th>Firewall name</th><td>{f.hostname}</td></tr>
                    <tr><th>Time zone</th><td>{f.timezone}</td></tr>
                    <tr><th>WAN (X1)</th><td className="mono">{f.wanMode === 'dhcp' ? 'DHCP' : `Static ${f.wanIp} / ${f.wanMask}, gateway ${f.wanGw}`}</td></tr>
                    {f.wanMode === 'static' ? <tr><th>DNS</th><td className="mono">{[f.dns1, f.dns2].filter(Boolean).join(', ') || 'none'}</td></tr> : null}
                    <tr><th>LAN (X0)</th><td className="mono">{x0.ip} / {x0.mask} (unchanged)</td></tr>
                  </tbody>
                </table>
              </>
            )}

            {step === 6 && (
              <>
                <PartyPopper size={34} color="var(--tw-accent)" />
                <h1 style={{ marginTop: 8 }}>Setup complete</h1>
                <p className="lead">The configuration is applied. Log in as <b>{f.adminUser}</b> with your new password.</p>
                <Note kind="ok">Verify (task 0.3): the old password <span className="mono">password</span> no longer works.</Note>
              </>
            )}
          </div>

          <div className="foot">
            <button className="tw-btn" onClick={step === 0 || step === 6 ? onClose : () => setStep((s) => s - 1)}>
              {step === 0 ? 'Cancel' : step === 6 ? 'Close' : 'Back'}
            </button>
            {step < 6 ? (
              <button className="tw-btn tw-btn-primary" data-guide="wiz-next" onClick={next}>{step === 5 ? 'Apply' : 'Next'}</button>
            ) : (
              <button className="tw-btn tw-btn-primary" data-guide="wiz-next" onClick={onClose}>Done</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
