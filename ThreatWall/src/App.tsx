import './auth/auth.css';
import './training/training.css';
import './brand/brand.css';
import './notebook/notebook.css';
import { useEffect, useState } from 'react';
import { StoreProvider, useStore } from './state/store';
import { ui } from './state/ui';
import { ToastProvider } from './components/Toast';
import { CertWarning } from './auth/CertWarning';
import { Login } from './auth/Login';
import { AppShell } from './shell/AppShell';
import { BrowserChrome } from './auth/BrowserFrame';
import { BrowserError, NewTab } from './auth/BrowserPages';
import { browse } from './auth/browser';
import { TaskPanel } from './training/TaskPanel';
import { GuideOverlay } from './training/GuideOverlay';
import { TaskRunner } from './training/TaskRunner';
import { LabTools } from './training/LabTools';
import { Home } from './brand/Home';
import { Record } from './brand/Record';
import { Notebook } from './notebook/Notebook';
import { SmallScreenNotice } from './components/SmallScreenNotice';
import { IdentityNotice } from './components/IdentityNotice';

/** Training-layer screens live outside the simulated appliance: #/start (home), #/record, #/notebook[/task]. Anything else is the lab. */
type Screen = 'home' | 'record' | 'notebook' | 'lab';
const screenOf = (): Screen => {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (h === '' || h === 'start') return 'home';
  if (h === 'record') return 'record';
  if (h === 'notebook' || h.startsWith('notebook/')) return 'notebook';
  return 'lab';
};
function useScreen(): { screen: Screen; focus?: string } {
  const [hash, set] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => { set(window.location.hash); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const screen = screenOf();
  useEffect(() => { window.scrollTo(0, 0); document.body.dataset.screen = screen; document.documentElement.dataset.screen = screen; }, [screen]);
  const focus = screen === 'notebook' ? hash.replace(/^#\/?notebook\/?/, '') || undefined : undefined;
  return { screen, focus };
}

/** What the ADMIN-PC browser tab shows, decided by the simulated network. */
function Gate() {
  const { state, session, patchSession } = useStore();
  const out = browse(state, session.browserUrl);
  const reachable = out.kind === 'firewall';

  // Once the management page answers again on the address in use, the "connection lost" notice is obsolete.
  useEffect(() => {
    if (reachable && session.disconnected) patchSession({ disconnected: null });
  }, [reachable, session.disconnected, patchSession]);

  const preLogin = out.kind !== 'firewall' ? (out.kind === 'blank' ? 'browser:blank' : 'browser:error') : null;
  useEffect(() => { if (preLogin && !session.loggedIn) ui.setRoute(preLogin); }, [preLogin, session.loggedIn]);

  if (session.loggedIn) {
    const lost = reachable ? null : out.kind === 'error' ? out.detail : 'The address bar is empty.';
    return <AppShell lost={lost} />;
  }
  if (out.kind === 'blank') return <NewTab />;
  if (out.kind === 'error') return <BrowserError code={out.code} title={out.title} detail={out.detail} />;
  // A certificate from the internal CA (task 4.4) is trusted by the lab PCs, so no warning appears.
  if (!session.certAccepted && state.config.system.certificate === 'Default self-signed certificate') return <CertWarning />;
  return <Login />;
}

function Layout() {
  const { progress } = useStore();
  const { screen, focus } = useScreen();
  // Lets the appliance toasts sit clear of the training panel (see .tw-toasts in index.css).
  useEffect(() => { document.body.dataset.panel = progress.panelOpen ? 'open' : 'closed'; }, [progress.panelOpen]);
  if (screen !== 'lab') {
    return <>{screen === 'home' ? <Home /> : screen === 'record' ? <Record /> : <Notebook focus={focus} />}<TaskRunner /></>;
  }
  return (
    <div className={`tw-root${progress.panelOpen ? ' panel-open' : ''}`}>
      <SmallScreenNotice />
      <div className="tw-stage">
        <IdentityNotice variant="stage" />
        <BrowserChrome>
          <div className="tw-stage-body"><Gate /></div>
        </BrowserChrome>
        <LabTools />
      </div>
      <TaskPanel />
      <GuideOverlay />
      <TaskRunner />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <ToastProvider>
        <Layout />
      </ToastProvider>
    </StoreProvider>
  );
}
