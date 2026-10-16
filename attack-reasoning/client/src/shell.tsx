// ThreatReady platform shell (header, account menu, footer, theme toggle) in threatready.io's design.
// Same markup and platform.css as onboard (Threatready-landing-page-main/apps/web/src/components).
// Identical copy in attack-reasoning/client/src/shell.tsx; keep them in step.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './platform.css';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api, BASE, onboardLinks, signOut } from './api';

type AppKey = 'interview' | 'labs' | 'reasoning';
interface PlatformApp { key: AppKey; title: string; url: string; status: string }
// Relative to each app's base URL (it may include a path, e.g. https://host/labs/).
const APP_PATH: Record<AppKey, string> = { interview: 'interview-prep', labs: '', reasoning: '' };
/** Used until onboard's registry answers; the registry's titles win once loaded. */
const FALLBACK_TITLE: Record<AppKey, string> = { interview: 'InterviewPrep', labs: 'Lab Simulations', reasoning: 'Attack Reasoning Lab' };
const href = (a: PlatformApp) => new URL(APP_PATH[a.key], a.url).toString();

export function ThemeToggle() {
  const [light, setLight] = useState(() => document.documentElement.getAttribute('data-theme') === 'light');
  const toggle = () => {
    const next = !light; setLight(next);
    // theme-init.js (loaded in <head>) stores it in the shared cookie for every ThreatReady app.
    (window as unknown as { trSetTheme: (t: string) => void }).trSetTheme(next ? 'light' : 'dark');
  };
  return <button type="button" className="tr-theme-btn" onClick={toggle} aria-label={light ? 'Switch to dark theme' : 'Switch to light theme'} title={light ? 'Dark theme' : 'Light theme'}>
    <svg className="tr-icon tr-i-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" /></svg>
    <svg className="tr-icon tr-i-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
  </button>;
}

const initials = (name: string) => name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?';
const Avatar = ({ user, size }: { user: { name: string; image?: string | null }; size: number }) =>
  <span className="tr-avatar" style={{ width: size, height: size }}>{user.image ? <img src={user.image} alt="" referrerPolicy="no-referrer" /> : initials(user.name)}</span>;
const Icon = ({ d }: { d: string }) => <svg className="tr-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;

/** Account menu; on small screens it also lists every app (the inline switcher is hidden there). */
function AccountMenu({ user, apps, current }: { user: { name: string; email?: string | null; image?: string | null; isAdmin?: boolean }; apps: PlatformApp[]; current: AppKey }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null); const btn = useRef<HTMLButtonElement>(null); const id = useId();
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('pointerdown', onPointer); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return <div className="tr-menu" ref={root}>
    <button ref={btn} type="button" className="tr-menu-btn" aria-haspopup="true" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
      <Avatar user={user} size={28} /><span className="tr-user-name">{user.name}</span>
      <svg className="tr-chev" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <span className="tr-sr">Account and apps menu</span>
    </button>
    {open && <div className="tr-menu-pop" id={id}>
      <div className="tr-menu-head"><Avatar user={user} size={36} /><div><strong>{user.name}</strong>{user.email && <span>{user.email}</span>}</div></div>
      <div className="tr-menu-apps">
        <span className="tr-menu-label">Apps</span>
        <a className="tr-menu-item" href={onboardLinks.home}><Icon d="M4 11l8-7 8 7v9a1 1 0 01-1 1h-5v-6h-4v6H5a1 1 0 01-1-1z" />Home</a>
        {apps.map(a => a.status === 'live'
          ? <a key={a.key} className="tr-menu-item" href={href(a)} aria-current={a.key === current ? 'page' : undefined}><span className={`tr-dot tr-dot-${a.key}`} aria-hidden="true" />{a.title}</a>
          : <span key={a.key} className="tr-menu-item" aria-disabled="true"><span className={`tr-dot tr-dot-${a.key}`} aria-hidden="true" />{a.title}<span className="tr-tag tr-tag-soon tr-tag-plain">Soon</span></span>)}
        <div className="tr-menu-sep" />
      </div>
      <a className="tr-menu-item" href={onboardLinks.profile}><Icon d="M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c1-4 4-6 8-6s7 2 8 6" />Profile and progress</a>
      {user.isAdmin && <a className="tr-menu-item" href={onboardLinks.home + '/admin'}><Icon d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />Admin console</a>}
      <div className="tr-menu-sep" />
      <button type="button" className="tr-menu-item" onClick={signOut}><Icon d="M9 4H5v16h4M15 8l4 4-4 4M19 12H9" />Sign out</button>
    </div>}
  </div>;
}

/** The last app list seen, so the header is complete on first paint (refreshed from /platform after). */
const APPS_KEY = 'tr-platform-apps';
export const cachedApps = (): PlatformApp[] => { try { const v = JSON.parse(localStorage.getItem(APPS_KEY) || 'null'); return Array.isArray(v?.apps) ? v.apps : []; } catch { return []; } };
export const rememberApps = (apps: PlatformApp[]) => { try { localStorage.setItem(APPS_KEY, JSON.stringify({ at: Date.now(), apps })); } catch { /* storage unavailable */ } };
/** Fetched once, started by App alongside the session check so the header is complete when it first renders. */
let platformFetch: Promise<PlatformApp[]> | null = null;
export const platformApps = () => (platformFetch ??= api('/platform').then((p: any) => { const list = Array.isArray(p?.apps) ? p.apps : []; if (list.length) rememberApps(list); return list.length ? list : cachedApps(); }, () => cachedApps()));

/**
 * The one loading screen every ThreatReady app shows while it opens. It never mentions sign-in:
 * a signed-out visitor is redirected to onboard and brought back, never shown a form here.
 */
export function PlatformLoading({ app }: { app: string }) {
  return <div className="trp tr-loading" role="status" aria-live="polite">
    <div className="tr-loading-in">
      <span className="tr-loading-mark"><img src={`${BASE}logo-sm.png`} alt="" />ThreatReady</span>
      <span className="tr-loading-bar" aria-hidden="true"><i /></span>
      <p>Opening {app}…</p>
    </div>
  </div>;
}

export function PlatformHeader({ current, user }: { current: AppKey; user: any }) {
  const [apps, setApps] = useState<PlatformApp[]>(cachedApps);
  useEffect(() => { let on = true; platformApps().then((list) => { if (on && list.length) setApps(list); }); return () => { on = false; }; }, []);
  const title = apps.find(a => a.key === current)?.title ?? FALLBACK_TITLE[current];
  return <header className="tr-nav"><div className="tr-wrap tr-nav-in">
    <a className="tr-brand" href={BASE} aria-label={`ThreatReady ${title} home`}><img src={`${BASE}logo-sm.png`} width="26" height="25" alt="" />ThreatReady<small>{title}</small></a>
    <nav aria-label="ThreatReady apps"><ul className="tr-apps">
      <li><a className="tr-app-link" href={onboardLinks.home}>Home</a></li>
      {apps.map(a => <li key={a.key}>{a.status === 'live'
        ? <a className="tr-app-link" href={href(a)} aria-current={a.key === current ? 'page' : undefined}><span className={`tr-dot tr-dot-${a.key}`} aria-hidden="true" />{a.title}</a>
        : <span className="tr-app-link" aria-disabled="true" title="Coming soon"><span className={`tr-dot tr-dot-${a.key}`} aria-hidden="true" />{a.title}<span className="tr-tag tr-tag-soon tr-tag-plain">Soon</span></span>}</li>)}
    </ul></nav>
    <div className="tr-nav-end"><ThemeToggle /><AccountMenu user={user} apps={apps} current={current} /></div>
  </div></header>;
}

const SITE = 'https://threatready.io';
export function PlatformFooter() {
  return <footer className="tr-footer"><div className="tr-wrap">
    <div className="tr-footer-in">
      <div><a className="tr-brand" href={SITE}><img src={`${BASE}logo-sm.png`} width="26" height="25" alt="" />ThreatReady</a>
        <p>Role-based assessment of security reasoning and interview readiness. A product of Aerovant Technologies.</p></div>
      <nav aria-label="Legal and help"><ul>
        {[['How it works', 'how-it-works'], ['Scoring rubric', 'rubric'], ['Security', 'security'], ['Privacy', 'privacy'], ['Terms', 'terms'], ['Contact', 'contact']].map(([l, p]) =>
          <li key={p}><a href={`${SITE}/${p}.html`} target="_blank" rel="noopener noreferrer">{l}</a></li>)}
      </ul></nav>
    </div>
    <div className="tr-footer-bottom"><span>© {new Date().getFullYear()} Aerovant Technologies Pvt. Ltd.</span><span>Simulated environments only. No real systems are touched.</span></div>
  </div></footer>;
}

export function Shell({ current, user, children }: { current: AppKey; user: any; children: ReactNode }) {
  return <div className="trp tr-shell">
    <a className="tr-skip" href="#main">Skip to content</a>
    <PlatformHeader current={current} user={user} /><main id="main" tabIndex={-1}>{children}</main><PlatformFooter />
  </div>;
}
