import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { FlaskConical, Lock, RotateCw, TriangleAlert } from 'lucide-react';
import { useStore } from '../state/store';
import { browse, parseUrl } from './browser';

/**
 * Simulated browser on ADMIN-PC. The address bar is real input: the learner types the firewall address (task 0.2,
 * and again after re-addressing X0 in task 1.1). Whether the page loads is decided by the traffic engine.
 */
export function BrowserChrome({ children }: { children: ReactNode }) {
  const { state, session, patchSession, emit } = useStore();
  const [text, setText] = useState(session.browserUrl);
  useEffect(() => { setText(session.browserUrl); }, [session.browserUrl]);
  const u = parseUrl(session.browserUrl);
  const trusted = state.config.system.certificate !== 'Default self-signed certificate' && !!u && u.scheme === 'https';
  const narrow = useNarrow();

  const go = (e?: FormEvent) => {
    e?.preventDefault();
    const raw = text.trim();
    const p = parseUrl(raw);
    const out = browse(state, raw);
    const sameOrigin = p && u && p.host === u.host && p.port === u.port;
    const patch: Partial<typeof session> = { browserUrl: raw };
    if (!sameOrigin) Object.assign(patch, { certAccepted: false, loggedIn: false, user: null });
    if (out.kind === 'firewall') Object.assign(patch, { connectedIp: out.ip, connectedVia: out.iface, connectedPort: out.port, disconnected: null });
    patchSession(patch);
    emit('browse', { url: raw, host: p?.host ?? '', port: p?.port ?? 0, scheme: p?.scheme ?? '', result: out.kind === 'error' ? out.code : out.kind });
  };

  return (
    <div className="tw-stage-browser">
      <form className="tw-urlbar" onSubmit={go} aria-label="Simulated browser address bar">
        <button type="button" className="tw-url-btn" title="Reload" aria-label="Reload" onClick={() => go()}><RotateCw size={14} /></button>
        <div className="url">
          {u ? (trusted ? <Lock size={13} color="#188038" aria-label="Secure connection" /> : <span className="insecure"><TriangleAlert size={13} aria-hidden="true" /> <span className="lbl">Not secure</span></span>) : null}
          <input
            data-guide="url"
            className="mono"
            value={text}
            spellCheck={false}
            placeholder={narrow ? 'e.g. https://192.168.168.168' : 'Type a web address, e.g. https://192.168.168.168'}
            onChange={(e) => setText(e.target.value)}
            onFocus={(e) => e.target.select()}
            aria-label="Address"
          />
        </div>
        <span className="tw-url-who" title="The browser runs on your lab workstation">ADMIN-PC browser</span>
      </form>
      {children}
    </div>
  );
}

/** True on phone-width screens, where the address bar has room only for a short placeholder (OVF-14). */
function useNarrow(): boolean {
  const q = '(max-width: 600px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

/** Pre-login pages: adds the lab banner under the address bar. */
export function BrowserFrame({ children }: { host?: string; trusted?: boolean; children: ReactNode }) {
  return (
    <div className="tw-browser">
      <div className="tw-lab-banner">
        <FlaskConical size={14} />
        Simulated appliance · ThreatWall is a fictional firewall used for ThreatReady Firewall training. All traffic is simulated in your browser; no real firewall, network or credentials are used.
      </div>
      {children}
    </div>
  );
}
