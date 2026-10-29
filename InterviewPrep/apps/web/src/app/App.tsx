import { useQuery } from '@tanstack/react-query';
import { History, LayoutDashboard, Plus } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router';
import { api, ApiError, messageFor } from '../lib/api';
import { redirectToSignIn, redirectToSignUp, useMe } from '../lib/auth';
import { PlatformFooter, PlatformHeader, PlatformLoading } from './PlatformShell';
import { Busy, CardSkeleton, focusMainHeading, NotFoundState, RouteErrorBoundary, ToastProvider, usePageTitle } from '../ui/components';

const Dashboard = lazy(() => import('../features/interview-prep/pages/DashboardPage'));
const CreateInterview = lazy(() => import('../features/interview-prep/pages/CreateInterviewPage'));
const SessionPage = lazy(() => import('../features/interview-prep/pages/SessionPage'));
// Development only: photographs the 3D interviewer for the 2D photo fallback (see avatar/CapturePage.tsx).
const CapturePage = import.meta.env.DEV ? lazy(() => import('../features/interview-prep/avatar/CapturePage')) : null;
const ReportPage = lazy(() => import('../features/interview-prep/pages/ReportPage'));
const HistoryPage = lazy(() => import('../features/interview-prep/pages/HistoryPage'));

/** The session check failed (API down, network): say so and offer a retry, never an endless loader. */
function OpenError({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying: boolean }) {
  return (
    <div className="page">
      <div className="card stack">
        <h1 className="h-sm">InterviewPrep couldn’t open</h1>
        <p role="alert">{messageFor(error)}</p>
        <div>
          <button className="btn" type="button" onClick={onRetry} disabled={retrying}>
            {retrying ? <Busy label="Trying again…" /> : 'Try again'}
          </button>
        </div>
      </div>
    </div>
  );
}

const accountRequired = (error: unknown) => error instanceof ApiError && error.code === 'AUTH_ACCOUNT_REQUIRED';

/** Signed in on onboard.threatready.io, or sent there and brought back to this page. */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data, isPending, error, refetch, isFetching } = useMe();
  const needsAccount = accountRequired(error);
  useEffect(() => {
    if (!isPending && data === null) redirectToSignIn();
    if (needsAccount) redirectToSignUp();
  }, [isPending, data, needsAccount]);
  // A failed background refresh keeps the page: only a session that was never confirmed shows the error.
  if (error && !needsAccount && !data) return <OpenError error={error} onRetry={() => void refetch()} retrying={isFetching} />;
  if (isPending || !data) return <PlatformLoading />;
  return <>{children}</>;
}

/**
 * After an in-app navigation, focus moves to the new screen's h1 so screen readers announce it. Not on the
 * first screen: the comparison is with the last path focused, not a first-run flag, because React StrictMode
 * runs effects twice in development and a flag reset by the second run focused (and outlined) the h1 on load.
 */
function RouteFocus() {
  const { pathname } = useLocation();
  const last = useRef(pathname);
  useEffect(() => {
    if (last.current === pathname) return;
    last.current = pathname;
    focusMainHeading();
  }, [pathname]);
  return null;
}

/** An address under /interview-prep that is no screen: say so, rather than silently showing the dashboard. */
function NotFoundScreen() {
  usePageTitle('Page not found');
  return (
    <NotFoundState title="Page not found" to="/interview-prep" linkLabel="Go to the dashboard">
      There is nothing at this address. The link may be mistyped or out of date.
    </NotFoundState>
  );
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
            <Plus className="icon sm" aria-hidden /> <span>New<span className="subnav-long"> interview</span></span>
          </NavLink>
        </div>
      </div>
    </nav>
  );
}

export function App() {
  const { data, isPending, error, refetch, isFetching } = useMe();
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

  // The session check failed: an error with "Try again" (checked first: a refetch from a remounting
  // route used to flip it back to pending and keep the loader up for as long as the API was down).
  if (error && !data && !accountRequired(error)) {
    return (
      <div className="ip-shell tr-shell">
        <main id="main" tabIndex={-1}><OpenError error={error} onRetry={() => void refetch()} retrying={isFetching} /></main>
      </div>
    );
  }
  // One loading screen, shared with every ThreatReady app, until the session is known.
  if (isPending || (platform.isPending && !capped)) return <PlatformLoading />;

  return (
    <ToastProvider>
      <div className="ip-shell tr-shell">
        <a href="#main" className="tr-skip">Skip to content</a>
        <RouteFocus />
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
                  {CapturePage && <Route path="/interview-prep/__capture" element={<CapturePage />} />}
                  <Route path="*" element={<RequireAuth><NotFoundScreen /></RequireAuth>} />
                </Routes>
              </Suspense>
            </RouteErrorBoundary>
        </main>
        {data && <PlatformFooter />}
      </div>
    </ToastProvider>
  );
}
