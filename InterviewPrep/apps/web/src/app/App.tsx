import { useQuery } from '@tanstack/react-query';
import { History, LayoutDashboard, Plus } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import { api, ApiError, messageFor } from '../lib/api';
import { redirectToSignIn, redirectToSignUp, useMe } from '../lib/auth';
import { PlatformFooter, PlatformHeader, PlatformLoading } from './PlatformShell';
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
  if (isPending || !data) return <PlatformLoading />;
  return <>{children}</>;
}

/**
 * InterviewPrep's own navigation, under the shared ThreatReady header: the same position and style
 * as every app's secondary navigation, with this month's usage and the primary action.
 */
function SubNav() {
  const { data } = useMe();
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, enabled: Boolean(data) });
  const usage = dash.data?.usage;
  return (
    <nav className="subnav" aria-label="InterviewPrep">
      <div className="tr-wrap subnav-in">
        <NavLink to="/interview-prep" end className="subnav-link">
          <LayoutDashboard className="icon sm" aria-hidden /> Dashboard
        </NavLink>
        <NavLink to="/interview-prep/history" className="subnav-link">
          <History className="icon sm" aria-hidden /> History
        </NavLink>
        <div className="subnav-end">
          {usage && (
            <span className="subnav-usage" title="Interviews started this month against your monthly quota">
              <b className="tabular">{usage.interviewsThisMonth}</b> / {usage.monthlyQuota} this month
            </span>
          )}
          <NavLink to="/interview-prep/new" className="btn primary sm">
            <Plus className="icon sm" aria-hidden /> New interview
          </NavLink>
        </div>
      </div>
    </nav>
  );
}

export function App() {
  const { data, isPending } = useMe();
  // The app list loads with the session check (same key as the header's query) and the loading screen waits for
  // both, capped at 1.5 s, so the app switcher is never half-filled on first render.
  const platform = useQuery({ queryKey: ['platform'], queryFn: api.platform, staleTime: 300_000 });
  const [capped, setCapped] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setCapped(true), 1500); return () => window.clearTimeout(t); }, []);
  useEffect(() => {
    // Session ended mid-use (signed out in another app, expired): sign in on onboard and return here.
    window.addEventListener('tr:auth-required', redirectToSignIn);
    window.addEventListener('tr:account-required', redirectToSignUp);
    return () => {
      window.removeEventListener('tr:auth-required', redirectToSignIn);
      window.removeEventListener('tr:account-required', redirectToSignUp);
    };
  }, []);

  // One loading screen, shared with every ThreatReady app, until the session is known.
  if (isPending || (platform.isPending && !capped)) return <PlatformLoading />;

  return (
    <ToastProvider>
      <div className="ip-shell tr-shell">
        <a href="#main" className="tr-skip">Skip to content</a>
        {data && <PlatformHeader user={data} />}
        {data && <SubNav />}
        <main id="main" tabIndex={-1}>
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
        {data && <PlatformFooter />}
      </div>
    </ToastProvider>
  );
}
