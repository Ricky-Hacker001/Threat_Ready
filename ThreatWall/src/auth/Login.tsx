import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, Eye, EyeOff } from 'lucide-react';
import { BrowserFrame } from './BrowserFrame';
import { SetupWizard } from './SetupWizard';
import { ShieldMark, Wordmark } from '../components/Logo';
import { useStore } from '../state/store';
import { hashPassword, labTotp } from '../lib/hash';
import { ui } from '../state/ui';

export function Login() {
  const { config, session, patchSession, addAudit, emit } = useStore();
  const sys = config.system;
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [otp, setOtp] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [fails, setFails] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [wizard, setWizard] = useState(false);

  useEffect(() => { ui.setRoute(wizard ? 'browser:wizard' : 'browser:login'); }, [wizard]);

  if (wizard) {
    return (
      <BrowserFrame host={session.connectedIp} trusted={false}>
        <SetupWizard onClose={() => setWizard(false)} />
      </BrowserFrame>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (Date.now() < lockedUntil) {
      setError(`Too many failed attempts. Try again in ${Math.ceil((lockedUntil - Date.now()) / 1000)} seconds.`);
      return;
    }
    if (!user.trim() || !pw) {
      setError('Enter your username and password.');
      return;
    }
    const ok = user.trim() === sys.adminUser && hashPassword(pw) === sys.adminPasswordHash;
    if (!ok) {
      const n = fails + 1;
      setFails(n);
      emit('login', { ok: false, user: user.trim(), defaultPw: pw === 'password' });
      addAudit([{ category: 'Session', action: 'Administrator login failed', detail: `User "${user.trim()}" from ${session.pc.ip}` }]);
      const lim = sys.lockout.enabled ? sys.lockout.attempts : 5;
      const ms = sys.lockout.enabled ? sys.lockout.minutes * 60_000 : 30_000;
      if (n >= lim) {
        setLockedUntil(Date.now() + ms);
        setFails(0);
        addAudit([{ category: 'Session', action: 'Administrator account locked out', detail: `${n} failed logins from ${session.pc.ip}` }]);
        setError(`Incorrect username or password. Login locked for ${sys.lockout.enabled ? `${sys.lockout.minutes} minute(s)` : '30 seconds'} after ${lim} failures.`);
      } else {
        setError(`Incorrect username or password. (${n} of ${lim} attempts)`);
      }
      return;
    }
    if (sys.setupComplete && sys.otpMethod === 'totp' && otp.trim() !== labTotp(sys.adminUser, Date.now())) {
      setError('One-time code missing or incorrect. Use the lab authenticator in Lab Tools › Lab Controls.');
      addAudit([{ category: 'Session', action: 'Administrator login failed (one-time code)', detail: `${sys.adminUser} from ${session.pc.ip}` }]);
      return;
    }
    emit('login', { ok: true, user: user.trim(), defaultPw: pw === 'password', setup: sys.setupComplete });
    if (!sys.setupComplete) {
      // A factory unit forces the Setup Guide so the default password cannot stay.
      setError('');
      setWizard(true);
      return;
    }
    patchSession({ loggedIn: true, user: sys.adminUser, lastActivity: Date.now() });
    addAudit([{ category: 'Session', action: 'Administrator login', detail: `${sys.adminUser} from ${session.pc.ip} via ${session.connectedVia}` }]);
  };

  return (
    <BrowserFrame host={session.connectedIp} trusted={false}>
      <main className="tw-login">
        <section className="tw-login-left">
          <div className="tw-login-brand">
            <ShieldMark size={40} />
            <Wordmark size={30} />
          </div>
          <p className="tw-login-sub">Firewall management · {sys.model}</p>

          <form className="tw-login-form" onSubmit={submit} noValidate>
            <label htmlFor="tw-user">Username</label>
            <div className="tw-login-field">
              <input id="tw-user" data-guide="login-user" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} placeholder="Enter your username" />
            </div>
            <label htmlFor="tw-pass">Password</label>
            <div className="tw-login-field">
              <input id="tw-pass" data-guide="login-pass" type={show ? 'text' : 'password'} autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Enter your password" />
              <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
                {show ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
            {sys.setupComplete && sys.otpMethod === 'totp' ? (
              <>
                <label htmlFor="tw-otp">One-time code</label>
                <div className="tw-login-field"><input id="tw-otp" data-guide="login-otp" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="6-digit code" /></div>
              </>
            ) : null}
            <button className="tw-login-submit" data-guide="login-submit" type="submit">SIGN IN</button>
            {error ? <div className="tw-login-err" role="alert"><AlertCircle size={15} /> {error}</div> : null}
          </form>

          {!sys.setupComplete ? (
            <p className="tw-login-setup">
              New appliance? <button type="button" data-guide="launch-wizard" onClick={() => setWizard(true)}>To launch the ThreatWall Setup Guide, click here.</button>
            </p>
          ) : null}

          <p className="tw-login-foot">ThreatWall is a fictional appliance used for ThreatReady Firewall training. Best viewed at 1920×1080 or larger.</p>
        </section>

        <section className="tw-login-right">
          <div className="tw-login-card">
            <h2>Appliance</h2>
            <dl className="tw-login-kv">
              <dt>Firewall name</dt><dd>{sys.hostname}</dd>
              <dt>Model</dt><dd>{sys.model}</dd>
              <dt>Firmware</dt><dd>{sys.firmware}</dd>
              <dt>Management address</dt><dd className="mono">https://{session.connectedIp}</dd>
              <dt>Connected from</dt><dd className="mono">{session.pc.name} · {session.pc.ip}</dd>
              <dt>Status</dt><dd>{sys.setupComplete ? 'Configured' : 'Factory defaults — setup required'}</dd>
            </dl>
          </div>
          {!sys.setupComplete ? (
            <div className="tw-login-card">
              <h2>Lab hint</h2>
              <details className="tw-login-hint">
                <summary>Show the factory credentials (task 0.3)</summary>
                <p style={{ margin: '10px 0 0' }}>
                  A new appliance uses username <b className="mono">admin</b> and password <b className="mono">password</b>. They are
                  public knowledge, which is why the Setup Guide makes you replace the password before anything else.
                </p>
              </details>
            </div>
          ) : null}
        </section>
      </main>
    </BrowserFrame>
  );
}
