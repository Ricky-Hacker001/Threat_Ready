import { useEffect, useState } from 'react';
import { useDraft } from '../../state/ui';
import { Info } from 'lucide-react';
import { useStore } from '../../state/store';
import { useToast } from '../../components/Toast';
import { Dialog, Note, Row, Section, Tabs, Toggle } from '../../components/ui';
import { applyAdmin, changePassword, validateAdmin, type AdminForm } from '../../services/deviceService';
import { LAB } from '../../state/baseline';

type Tab = 'admin' | 'login' | 'mgmt';

const pick = (s: AdminForm): AdminForm => ({
  hostname: s.hostname, domain: s.domain, description: s.description, adminUser: s.adminUser, adminTimeoutMin: s.adminTimeoutMin, otpMethod: s.otpMethod,
  lockout: { ...s.lockout }, httpsPort: s.httpsPort, certificate: s.certificate,
});

export function AdministrationPage() {
  const { config, session, commit, patchSession } = useStore();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('admin');
  const [f, setF] = useState<AdminForm>(() => pick(config.system));
  const [timeoutText, setTimeoutText] = useState(String(config.system.adminTimeoutMin));
  const [tried, setTried] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  // Re-sync if the saved config changes elsewhere (e.g. lab reset, restore).
  useEffect(() => { setF(pick(config.system)); setTimeoutText(String(config.system.adminTimeoutMin)); }, [config.system]);

  const form = { ...f, adminTimeoutMin: Number(timeoutText) };
  useDraft('admin', { hostname: f.hostname, adminTimeoutMin: timeoutText, adminUser: f.adminUser, otpMethod: f.otpMethod, lockout: f.lockout.enabled, attempts: f.lockout.attempts, minutes: f.lockout.minutes, httpsPort: f.httpsPort, certificate: f.certificate });
  const errors = validateAdmin(form);
  const e = tried ? errors : {};
  const dirty = JSON.stringify(form) !== JSON.stringify(pick(config.system));

  const accept = () => {
    setTried(true);
    if (Object.keys(errors).length) { toast('Fix the highlighted fields.', 'bad'); return; }
    const r = applyAdmin(config, form);
    commit(r.next, r.audit);
    if (form.adminUser !== config.system.adminUser) patchSession({ user: form.adminUser });
    setTried(false);
    toast('Administration settings saved.');
  };
  const cancel = () => { setF(pick(config.system)); setTimeoutText(String(config.system.adminTimeoutMin)); setTried(false); };

  const set = <K extends keyof AdminForm>(k: K, v: AdminForm[K]) => setF((p) => ({ ...p, [k]: v }));

  return (
    <div className="tw-page">
      <Tabs<Tab> tabs={[{ id: 'admin', label: 'Firewall Administrator' }, { id: 'login', label: 'Login / Multiple Administrators' }, { id: 'mgmt', label: 'Management' }]} value={tab} onChange={setTab} />

      {tab === 'admin' && (
        <>
          <Section title="Firewall Name">
            <div className="tw-form">
              <Row label="Firewall Name" htmlFor="ad-host" error={e.hostname} hint={<>Lab value: <b className="mono">{LAB.hostname}</b></>}>
                <input id="ad-host" className={`tw-input${e.hostname ? ' invalid' : ''}`} value={f.hostname} onChange={(ev) => set('hostname', ev.target.value)} />
                <span className="tw-info" title="Shown in the breadcrumb, logs and alerts."><Info size={14} /></span>
              </Row>
              <Row label="Firewall's Domain Name" htmlFor="ad-domain" error={e.domain}>
                <input id="ad-domain" className={`tw-input${e.domain ? ' invalid' : ''}`} value={f.domain} onChange={(ev) => set('domain', ev.target.value)} />
              </Row>
              <Row label="Description" htmlFor="ad-desc">
                <textarea id="ad-desc" className="tw-textarea" value={f.description} onChange={(ev) => set('description', ev.target.value)} />
              </Row>
            </div>
          </Section>
          <Section title="Administrator Name & Password">
            <div className="tw-form">
              <Row label="Administrator Login Name" htmlFor="ad-user" error={e.adminUser}>
                <input id="ad-user" className={`tw-input${e.adminUser ? ' invalid' : ''}`} value={f.adminUser} onChange={(ev) => set('adminUser', ev.target.value)} />
                <button className="tw-btn" type="button" onClick={() => setPwOpen(true)}>Change Password</button>
              </Row>
              <Row label="One-time Passwords Method" htmlFor="ad-otp" hint="Task 4.4 turns on TOTP for every administrator.">
                <select id="ad-otp" className="tw-select" value={f.otpMethod} onChange={(ev) => set('otpMethod', ev.target.value as AdminForm['otpMethod'])}>
                  <option value="disabled">Disabled</option>
                  <option value="totp">TOTP</option>
                </select>
              </Row>
            </div>
            {config.system.defaultPassword ? <Note kind="bad">The administrator still uses the factory password. Change it now.</Note> : null}
          </Section>
        </>
      )}

      {tab === 'login' && (
        <Section title="Login Security">
          <div className="tw-form">
            <Row label="Log out the Administrator after inactivity of" htmlFor="ad-timeout" error={e.adminTimeoutMin} hint="Lab value: 10 minutes (task 0.7).">
              <input id="ad-timeout" className={`tw-input${e.adminTimeoutMin ? ' invalid' : ''}`} style={{ width: 80 }} inputMode="numeric" value={timeoutText} onChange={(ev) => setTimeoutText(ev.target.value.trim())} />
              <span>minutes</span>
            </Row>
            <Row label="Enable administrator/user lockout" hint="Lock the account after repeated failed logins (task 4.4).">
              <Toggle id="ad-lockout" checked={f.lockout.enabled} onChange={(v) => set('lockout', { ...f.lockout, enabled: v })} label="Enable lockout" />
            </Row>
            {f.lockout.enabled ? <>
              <Row label="Failed login attempts per minute before lockout" htmlFor="ad-attempts" error={e.attempts}><input id="ad-attempts" className="tw-input" style={{ width: 80 }} value={String(f.lockout.attempts)} onChange={(ev) => set('lockout', { ...f.lockout, attempts: Number(ev.target.value.replace(/\D/g, '')) || 0 })} /></Row>
              <Row label="Lockout period (minutes)" htmlFor="ad-lockmin" error={e.minutes}><input id="ad-lockmin" className="tw-input" style={{ width: 80 }} value={String(f.lockout.minutes)} onChange={(ev) => set('lockout', { ...f.lockout, minutes: Number(ev.target.value.replace(/\D/g, '')) || 0 })} /></Row>
            </> : null}
            <Row label="Current session">
              <span className="val">{session.user} from {session.pc.ip} via {session.connectedVia} ({session.connectedIp})</span>
            </Row>
          </div>
        </Section>
      )}

      {tab === 'mgmt' && (
        <Section title="Web Management Settings">
          <div className="tw-form">
            <Row label="HTTPS Port" htmlFor="ad-port" error={e.httpsPort} hint="Changing it ends this session: reconnect with https://address:port.">
              <input id="ad-port" className={`tw-input mono${e.httpsPort ? ' invalid' : ''}`} style={{ width: 90 }} value={String(f.httpsPort)} onChange={(ev) => set('httpsPort', Number(ev.target.value.replace(/\D/g, '')) || 0)} />
            </Row>
            <Row label="Certificate Selection" htmlFor="ad-cert">
              <select id="ad-cert" className="tw-select" value={f.certificate} onChange={(ev) => set('certificate', ev.target.value)}>
                {config.certificates.filter((c) => c.type === 'Local').map((c) => <option key={c.name}>{c.name}</option>)}
              </select>
            </Row>
            <Row label="Enable IPv6"><Toggle checked={config.system.ipv6} disabled label="Enable IPv6" /></Row>
          </div>
          <Note kind="info">Import a certificate from your internal CA under DEVICE › Certificates, then select it here so browsers stop warning.</Note>
        </Section>
      )}

      {(tab === 'admin' || tab === 'login' || tab === 'mgmt') && (
        <div className="tw-form-actions">
          <button className="tw-btn" onClick={cancel} disabled={!dirty}>Cancel</button>
          <button className="tw-btn tw-btn-primary" data-guide="accept" onClick={accept} disabled={!dirty}>Accept</button>
        </div>
      )}

      {pwOpen && <PasswordDialog onClose={() => setPwOpen(false)} onDone={() => { setPwOpen(false); toast('Administrator password changed.'); }} />}
    </div>
  );
}

function PasswordDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { config, commit } = useStore();
  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const [cf, setCf] = useState('');
  const [err, setErr] = useState('');
  return (
    <Dialog title="Change Administrator Password" onClose={onClose} size="sm" footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" onClick={async () => {
        const r = await changePassword(config, cur, nw, cf);
        if (r.error) { setErr(r.error); return; }
        commit(r.result!.next, r.result!.audit);
        onDone();
      }}>Change</button>
    </>}>
      <div className="tw-form" style={{ gridTemplateColumns: '150px 1fr', paddingTop: 14 }}>
        <Row label="Current Password" htmlFor="pw-cur"><input id="pw-cur" type="password" autoComplete="off" name="fw-admin-current-passphrase" className="tw-input wide" value={cur} onChange={(e) => setCur(e.target.value)} /></Row>
        <Row label="New Password" htmlFor="pw-new"><input id="pw-new" type="password" autoComplete="new-password" className="tw-input wide" value={nw} onChange={(e) => setNw(e.target.value)} /></Row>
        <Row label="Confirm Password" htmlFor="pw-cf"><input id="pw-cf" type="password" autoComplete="new-password" className="tw-input wide" value={cf} onChange={(e) => setCf(e.target.value)} /></Row>
      </div>
      {err ? <Note kind="bad">{err}</Note> : null}
    </Dialog>
  );
}
