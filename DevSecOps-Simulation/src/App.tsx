import { useCallback, useEffect, useState } from 'react';
import { loadProgress, saveProgress, type Progress } from './store';
import { Welcome } from './pages/Welcome';
import { GetStarted } from './pages/GetStarted';
import { Dashboard } from './pages/Dashboard';
import { LabPage } from './pages/LabPage';
import { Brand } from './components/Brand';
import { IdentityNotice } from './components/IdentityNotice';
import { labById } from './content/labs';

function useHashRoute(): [string, (r: string) => void] {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#/, '') || '/');
  useEffect(() => {
    const on = () => setRoute(window.location.hash.replace(/^#/, '') || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((r: string) => {
    window.location.hash = r;
    window.scrollTo(0, 0);
  }, []);
  return [route, go];
}

export function App() {
  const [route, go] = useHashRoute();
  const [progress, setProgress] = useState<Progress>(loadProgress);
  const update = useCallback((fn: (p: Progress) => Progress) => {
    setProgress((p) => {
      const next = fn(p);
      saveProgress(next);
      return next;
    });
  }, []);

  const m = /^\/lab\/([\w-]+)$/.exec(route);
  const def = m ? labById(m[1]) : undefined;
  const page = (() => {
    if (route === '/start') return <GetStarted progress={progress} update={update} go={go} />;
    if (route === '/labs') return progress.mode ? <Dashboard progress={progress} update={update} go={go} /> : <GetStarted progress={progress} update={update} go={go} />;
    if (m) {
      if (!def) return <NotFound go={go} what={`There is no lab called “${m[1]}”.`} />;
      if (progress.mode) return <LabPage key={def.id} def={def} mode={progress.mode} progress={progress} update={update} go={go} />;
      return <Welcome go={go} hasProgress={false} />;
    }
    if (route !== '/' && route !== '') return <NotFound go={go} what={`Nothing is published at “${route}”.`} />;
    return <Welcome go={go} hasProgress={!!progress.mode} />;
  })();
  return (
    <>
      {/* The lab page places the account notice itself (inside its full-height workspace). */}
      {!(def && progress.mode) && <IdentityNotice />}
      {page}
    </>
  );
}

/** Unknown routes say so instead of silently showing the welcome page (UX-17). */
function NotFound({ go, what }: { go: (r: string) => void; what: string }) {
  useEffect(() => {
    document.title = 'Page not found · ThreatReady | DevSecOps Lab';
    return () => {
      document.title = 'ThreatReady | DevSecOps Lab';
    };
  }, []);
  return (
    <div className="page">
      <header className="topnav">
        <Brand onClick={() => go('/')} />
      </header>
      <main className="wrap section">
        <h1>Page not found</h1>
        <p className="sub">{what} The link may be out of date.</p>
        <div className="ctas">
          <button className="btn primary" onClick={() => go('/labs')}>
            Go to my labs
          </button>
          <button className="btn" onClick={() => go('/')}>
            Welcome page
          </button>
        </div>
      </main>
    </div>
  );
}
