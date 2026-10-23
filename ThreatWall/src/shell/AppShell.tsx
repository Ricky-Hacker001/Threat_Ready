import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bell, ChevronLeft, HelpCircle, LogOut, Menu, RotateCcw, Search, Settings, UserRound,
} from 'lucide-react';
import { VIEWS, firstRouteOf, routeFor, type Route } from './nav';
import { useRoute } from './router';
import { useStore } from '../state/store';
import { ShieldMark, Wordmark } from '../components/Logo';
import { Confirm, Dialog } from '../components/ui';
import { PageFor } from '../pages/registry';
import { Disconnected } from './Disconnected';
import { ui } from '../state/ui';
import { lastRouteKey } from '../brand/progress';

export function AppShell({ lost }: { lost: string | null }) {
  const { config, session, state, patchSession, addAudit, resetLab, emit } = useStore();
  const [path, go] = useRoute();
  const route = routeFor(path) as Route;
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [sideOpenMobile, setSideOpenMobile] = useState(false);
  const [menu, setMenu] = useState<null | 'user' | 'bell'>(null);
  const [dialog, setDialog] = useState<null | 'search' | 'help' | 'reset'>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set([`${route.view.id}/${route.group.id}`]));
  // Tell the task engine where the learner is.
  useEffect(() => {
    ui.setRoute(path); emit('nav', { path });
    try { localStorage.setItem(lastRouteKey(), path); } catch { /* storage unavailable */ }
  }, [path, emit]);
  const [seenAudit, setSeenAudit] = useState(state.audit[0]?.id ?? '');

  useEffect(() => {
    setOpenGroups((s) => new Set(s).add(`${route.view.id}/${route.group.id}`));
    setSideOpenMobile(false);
    document.title = `${route.item.label} · ThreatReady Firewall`;
  }, [route.view.id, route.group.id, route.item.label]);

  // Admin idle timeout (task 0.7 sets it to 10 minutes).
  useEffect(() => {
    const limit = config.system.adminTimeoutMin * 60_000;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const t = setInterval(() => {
      if (Date.now() - last > limit) {
        addAudit([{ category: 'Session', action: 'Administrator logged out (idle timeout)', detail: `${config.system.adminTimeoutMin} minutes without activity` }]);
        patchSession({ loggedIn: false, user: null });
      }
    }, 15_000);
    window.addEventListener('pointerdown', bump);
    window.addEventListener('keydown', bump);
    return () => { clearInterval(t); window.removeEventListener('pointerdown', bump); window.removeEventListener('keydown', bump); };
  }, [config.system.adminTimeoutMin, addAudit, patchSession]);

  const unread = state.audit.findIndex((a) => a.id === seenAudit);
  const unreadCount = unread === -1 ? Math.min(state.audit.length, 9) : Math.min(unread, 9);

  const logout = () => {
    addAudit([{ category: 'Session', action: 'Administrator logout', detail: session.user ?? '' }]);
    patchSession({ loggedIn: false, user: null });
  };

  const toggleSide = () => {
    if (window.matchMedia('(max-width: 860px)').matches) setSideOpenMobile((v) => !v);
    else setSideCollapsed((v) => !v);
  };

  return (
    <div className={`tw-app${sideCollapsed ? ' side-collapsed' : ''}${sideOpenMobile ? ' side-open' : ''}`}>
      <div className="tw-brand">
        <div className="tw-brand-mark"><ShieldMark size={24} /><Wordmark size={20} /></div>
        <div className="tw-brand-ver">{config.system.firmware.replace('ThreatWall ', '')}</div>
      </div>

      <header className="tw-topbar">
        <button className="tw-hamburger" onClick={toggleSide} aria-label="Toggle navigation menu">
          {sideCollapsed ? <Menu size={20} /> : <span style={{ display: 'inline-flex', alignItems: 'center' }}><ChevronLeft size={13} style={{ marginRight: -3 }} /><Menu size={19} /></span>}
        </button>
        <span className="tw-device">{config.system.model}</span>
        <nav className="tw-views" aria-label="Views">
          {VIEWS.map((v) => {
            const Icon = v.icon;
            const active = v.id === route.view.id;
            return (
              <button key={v.id} data-guide={`view:${v.id}`} className={`tw-view${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => go(firstRouteOf(v))}>
                <Icon size={16} /><span>{v.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="tw-top-right">
          <button className="tw-iconbtn hide-sm" title="Device settings" aria-label="Device settings" onClick={() => go('device/settings/administration')}><Settings size={18} /></button>
          <button className="tw-iconbtn" title="Notifications" aria-label={`Notifications, ${unreadCount} new`} onClick={() => { setMenu(menu === 'bell' ? null : 'bell'); setSeenAudit(state.audit[0]?.id ?? ''); }}>
            <Bell size={18} />{unreadCount > 0 ? <span className="tw-badge">{unreadCount}</span> : null}
          </button>
          <button className="tw-iconbtn" title="Help for this page" aria-label="Help for this page" onClick={() => setDialog('help')}><HelpCircle size={18} /></button>
          <button className="tw-iconbtn" title="Search pages" aria-label="Search pages" onClick={() => setDialog('search')}><Search size={18} /></button>
          <button className="tw-avatar" aria-label="Account menu" onClick={() => setMenu(menu === 'user' ? null : 'user')}>
            {(session.user ?? 'AD').slice(0, 2).toUpperCase()}
          </button>
        </div>
        {menu === 'user' && (
          <MenuPopover onClose={() => setMenu(null)}>
            <div className="tw-menu-head"><b>{session.user}</b><div className="muted" style={{ fontSize: 12 }}>Full administrator · from {session.pc.ip}</div></div>
            <button onClick={() => { setMenu(null); go('device/settings/administration'); }}><UserRound size={15} /> Administration</button>
            <button onClick={() => { setMenu(null); setDialog('reset'); }}><RotateCcw size={15} /> Reset lab to factory defaults</button>
            <button onClick={logout}><LogOut size={15} /> Log out</button>
          </MenuPopover>
        )}
        {menu === 'bell' && (
          <MenuPopover onClose={() => setMenu(null)}>
            <div className="tw-menu-head"><b>Recent events</b></div>
            {state.audit.slice(0, 6).map((a) => (
              <button key={a.id} onClick={() => { setMenu(null); go('monitor/logs/auditing-logs'); }} style={{ display: 'block' }}>
                <div style={{ fontWeight: 600 }}>{a.action}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{new Date(a.ts).toLocaleTimeString()} · {a.category}</div>
              </button>
            ))}
            {state.audit.length === 0 ? <div className="muted" style={{ padding: '6px 14px' }}>No events yet.</div> : null}
          </MenuPopover>
        )}
      </header>

      <div className="tw-crumbs">
        <ShieldMark size={17} />
        <ol aria-label="Breadcrumb">
          <li><a className="host" href="#/home/dashboard/system">{config.system.hostname}</a></li>
          <li>{route.view.label}</li>
          <li>{route.group.label}</li>
          <li aria-current="page">{route.item.label}</li>
        </ol>
        <span className="tw-mode" title="Changes you accept are applied to the simulated appliance">Configuration</span>
      </div>

      <aside className="tw-sidebar" aria-label={`${route.view.label} menu`}>
        {route.view.groups.map((g) => {
          const key = `${route.view.id}/${g.id}`;
          const open = openGroups.has(key);
          const Icon = g.icon;
          return (
            <div key={g.id}>
              {g.header ? <div className="tw-side-head">{g.header}</div> : null}
              <div className={`tw-group${open ? ' open' : ''}`}>
                <button className="tw-group-btn" data-guide={`group:${key}`} aria-expanded={open} onClick={() => setOpenGroups((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; })}>
                  <Icon size={17} />{g.label}
                </button>
                {open && (
                  <ul className="tw-items">
                    {g.items.map((i) => {
                      const p = `${route.view.id}/${g.id}/${i.id}`;
                      const active = p === path;
                      return (
                        <li key={i.id}>
                          <button data-guide={`nav:${p}`} className={`tw-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => go(p)}>{i.label}</button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
        <div className="tw-side-foot">Serial Number: {config.system.serial}</div>
      </aside>

      <main className="tw-main" id="main">
        <PageFor route={route} />
        {lost !== null ? <Disconnected detail={lost} /> : null}
      </main>

      {dialog === 'search' && <SearchDialog onClose={() => setDialog(null)} go={(p) => { setDialog(null); go(p); }} />}
      {dialog === 'help' && <HelpDialog route={route} onClose={() => setDialog(null)} />}
      {dialog === 'reset' && (
        <Confirm
          title="Reset lab"
          danger
          confirmLabel="Reset to factory defaults"
          message={<>This restores the appliance to factory defaults, clears every change and audit entry, and signs you out. You return to the ThreatReady home page and start again from the first task.</>}
          onCancel={() => setDialog(null)}
          onConfirm={() => { setDialog(null); resetLab(); window.location.hash = ''; ui.closeLab(); }}
        />
      )}
    </div>
  );
}

function MenuPopover({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => window.addEventListener('mousedown', h), 0);
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('mousedown', h); window.removeEventListener('keydown', k); };
  }, [onClose]);
  return <div className="tw-menu" ref={ref} role="menu">{children}</div>;
}

function SearchDialog({ onClose, go }: { onClose: () => void; go: (p: string) => void }) {
  const [q, setQ] = useState('');
  const all = useMemo(() => VIEWS.flatMap((v) => v.groups.flatMap((g) => g.items.map((i) => ({
    path: `${v.id}/${g.id}/${i.id}`, text: `${v.label} › ${g.label} › ${i.label}`, tasks: i.tasks,
  })))), []);
  const hits = all.filter((a) => a.text.toLowerCase().includes(q.toLowerCase()) || a.tasks.some((t) => t === q.trim()));
  return (
    <Dialog title="Go to page" onClose={onClose} size="sm">
      <div style={{ padding: '8px 16px' }}>
        <input className="tw-input" style={{ width: '100%' }} placeholder="Page name or task number, e.g. Interfaces or 1.4" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) go(hits[0].path); }} aria-label="Search pages" />
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: '0 8px 8px', maxHeight: 340, overflow: 'auto' }}>
        {hits.slice(0, 40).map((h) => (
          <li key={h.path}>
            <button className="tw-tool" style={{ width: '100%', justifyContent: 'space-between', padding: '7px 8px' }} onClick={() => go(h.path)}>
              <span style={{ color: 'var(--text)' }}>{h.text}</span>
              <span className="muted" style={{ fontSize: 11 }}>{h.tasks.length ? `Tasks ${h.tasks.join(', ')}` : ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function HelpDialog({ route, onClose }: { route: Route; onClose: () => void }) {
  return (
    <Dialog title={`Help · ${route.item.label}`} onClose={onClose} size="sm" footer={<button className="tw-btn tw-btn-primary" onClick={onClose}>Close</button>}>
      <div style={{ padding: '10px 16px', lineHeight: 1.6 }}>
        <p style={{ marginTop: 0 }}>Path: <b>{route.view.label.toUpperCase()} | {route.group.label} &gt; {route.item.label}</b></p>
        <p>Learning-track tasks that use this page: <b>{route.item.tasks.length ? route.item.tasks.join(', ') : 'none'}</b>.</p>
        <p className="muted" style={{ marginBottom: 0 }}>Open the task panel on the right for the guided steps of the current task.</p>
      </div>
    </Dialog>
  );
}
