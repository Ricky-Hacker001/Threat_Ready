import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, History, LayoutDashboard, LogOut, Plus, UserRound } from 'lucide-react';
import { lazy, Suspense, useEffect } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import { api, ApiError, messageFor } from '../lib/api';
import { onboardLinks, redirectToSignIn, redirectToSignUp, signOut, useMe } from '../lib/auth';
import { CardSkeleton, RouteErrorBoundary, ToastProvider } from '../ui/components';

const Dashboard = lazy(() => import('../features/interview-prep/pages/DashboardPage'));
const CreateInterview = lazy(() => import('../features/interview-prep/pages/CreateInterviewPage'));
const SessionPage = lazy(() => import('../features/interview-prep/pages/SessionPage'));
const ReportPage = lazy(() => import('../features/interview-prep/pages/ReportPage'));
const HistoryPage = lazy(() => import('../features/interview-prep/pages/HistoryPage'));

/** Signed in on onboard.threatready.io, or sent there and brought back to this page. */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data, isPending, error, refetch } = useMe();
  const accountRequired = error instanceof ApiError && error.code === 'AUTH_ACCOUNT_REQUIRED';
  useEffect(() => {
    if (!isPending && data === null) redirectToSignIn();
    if (accountRequired) redirectToSignUp();
  }, [isPending, data, accountRequired]);
  if (error && !accountRequired) {
    return (
      <div className="page">
        <div className="card stack">
          <p>{messageFor(error)}</p>
          <div><button className="btn" type="button" onClick={() => void refetch()}>Try again</button></div>
        </div>
      </div>
    );
  }
  if (isPending || !data) return <div className="page"><CardSkeleton /></div>;
  return <>{children}</>;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

function Sidebar() {
  const { data } = useMe();
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, enabled: Boolean(data) });
  if (!data) return null;
  const usage = dash.data?.usage;
  return (
    <aside className="sidebar" aria-label="Main navigation">
      <div className="brand">
        <img className="brand-logo" src="/logo-sm.png" width="28" height="27" alt="" />
        <span>
          ThreatReady
          <small>InterviewPrep</small>
        </span>
      </div>
      <NavLink to="/interview-prep/new" className="btn primary side-cta">
        <Plus className="icon sm" aria-hidden /> New interview
      </NavLink>
      <div className="nav-section">Practice</div>
      <NavLink to="/interview-prep" end className="side-link">
        <LayoutDashboard className="icon" aria-hidden /> Dashboard
      </NavLink>
      <NavLink to="/interview-prep/history" className="side-link">
        <History className="icon" aria-hidden /> History
      </NavLink>
      <div className="nav-section">ThreatReady</div>
      <a href={onboardLinks.profile} className="side-link">
        <UserRound className="icon" aria-hidden /> Profile and progress
      </a>
      <a href={onboardLinks.home} className="side-link">
        <ArrowUpRight className="icon" aria-hidden /> All ThreatReady apps
      </a>
      <div className="spacer" />
      {usage && (
        <div className="usage-card">
          <div className="row between">
            <span className="subtle">Interviews this month</span>
            <strong className="tabular">{usage.interviewsThisMonth}/{usage.monthlyQuota}</strong>
          </div>
          <div className="meter thin">
            <i style={{ width: `${Math.min(100, (usage.interviewsThisMonth / usage.monthlyQuota) * 100)}%` }} />
          </div>
        </div>
      )}
      <div className="user-chip">
        <span className="avatar-dot" aria-hidden>{initials(data.name)}</span>
        <div className="who">
          {data.name}
          <span>{data.email}</span>
        </div>
        <button className="btn ghost icon-only sm" type="button" title="Sign out of ThreatReady" aria-label="Sign out of ThreatReady" onClick={signOut}>
          <LogOut className="icon sm" />
        </button>
      </div>
    </aside>
  );
}

function MobileBar() {
  const { data } = useMe();
  if (!data) return null;
  return (
    <header className="mobile-bar">
      <img className="brand-logo" src="/logo-sm.png" width="24" height="23" alt="" />
      <strong>InterviewPrep</strong>
      <nav aria-label="Main navigation">
        <NavLink to="/interview-prep" end aria-label="Dashboard"><LayoutDashboard className="icon" /></NavLink>
        <NavLink to="/interview-prep/new" aria-label="New interview"><Plus className="icon" /></NavLink>
        <NavLink to="/interview-prep/history" aria-label="History"><History className="icon" /></NavLink>
        <a href={onboardLinks.profile} aria-label="Profile and progress"><UserRound className="icon" /></a>
        <a href={onboardLinks.home} aria-label="All ThreatReady apps"><ArrowUpRight className="icon" /></a>
        <button type="button" className="mobile-bar-btn" aria-label="Sign out of ThreatReady" onClick={signOut}><LogOut className="icon" /></button>
      </nav>
    </header>
  );
}

export function App() {
  const { data } = useMe();
  useEffect(() => {
    // Session ended mid-use (signed out in another app, expired): sign in on onboard and return here.
    window.addEventListener('tr:auth-required', redirectToSignIn);
    window.addEventListener('tr:account-required', redirectToSignUp);
    return () => {
      window.removeEventListener('tr:auth-required', redirectToSignIn);
      window.removeEventListener('tr:account-required', redirectToSignUp);
    };
  }, []);

  const bare = !data;
  return (
    <ToastProvider>
      <a href="#main" className="skip-link">Skip to content</a>
      <div className={`shell ${bare ? 'bare' : ''}`}>
        {!bare && <Sidebar />}
        <div className="content">
          {!bare && <MobileBar />}
          <main id="main">
            <RouteErrorBoundary>
              <Suspense fallback={<div className="page"><CardSkeleton lines={4} /></div>}>
                <Routes>
                  {/* Old bookmark: sign-in now happens on onboard.threatready.io. */}
                  <Route path="/sign-in" element={<RequireAuth><Navigate to="/interview-prep" replace /></RequireAuth>} />
                  <Route path="/interview-prep" element={<RequireAuth><Dashboard /></RequireAuth>} />
                  <Route path="/interview-prep/new" element={<RequireAuth><CreateInterview /></RequireAuth>} />
                  <Route path="/interview-prep/history" element={<RequireAuth><HistoryPage /></RequireAuth>} />
                  <Route path="/interview-prep/sessions/:id" element={<RequireAuth><SessionPage /></RequireAuth>} />
                  <Route path="/interview-prep/sessions/:id/report" element={<RequireAuth><ReportPage /></RequireAuth>} />
                  <Route path="*" element={<Navigate to="/interview-prep" replace />} />
                </Routes>
              </Suspense>
            </RouteErrorBoundary>
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
