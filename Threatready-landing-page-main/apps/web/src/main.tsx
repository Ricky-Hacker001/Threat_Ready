import { lazy, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { AppShell } from "./components/AppShell";
import { captureNext } from "./lib/platform";
import { AuthPage } from "./pages/AuthPage";
import { InvitePage } from "./pages/InvitePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { SignOutPage } from "./pages/SignOutPage";
import "./styles/app.css";

// The public sign-in page is most first visits, so the signed-in pages come as their own chunks once there
// is a session (AppShell shows a short loading line meanwhile), and the admin console, which only admins
// open, never reaches anyone else's browser. AdminGate stays inside the admin chunk.
const ProductPage = lazy(() => import("./pages/ProductPage").then((m) => ({ default: m.ProductPage })));
const ProfilePage = lazy(() => import("./pages/ProfilePage").then((m) => ({ default: m.ProfilePage })));
const ModulePage = lazy(() => import("./pages/ModulePage").then((m) => ({ default: m.ModulePage })));
const AdminRoute = lazy(() =>
  import("./pages/AdminPage").then((m) => ({
    default: () => (
      <m.AdminGate>
        <m.AdminPage />
      </m.AdminGate>
    ),
  })),
);
const AdminUserRoute = lazy(() =>
  Promise.all([import("./pages/AdminPage"), import("./pages/AdminUserPage")]).then(([a, u]) => ({
    default: () => (
      <a.AdminGate>
        <u.AdminUserPage />
      </a.AdminGate>
    ),
  })),
);
const AdminOrgsRoute = lazy(() =>
  Promise.all([import("./pages/AdminPage"), import("./pages/AdminOrgsPage")]).then(([a, o]) => ({
    default: () => (
      <a.AdminGate>
        <o.AdminOrgsPage />
      </a.AdminGate>
    ),
  })),
);
const AdminOrgRoute = lazy(() =>
  Promise.all([import("./pages/AdminPage"), import("./pages/AdminOrgsPage")]).then(([a, o]) => ({
    default: () => (
      <a.AdminGate>
        <o.AdminOrgPage />
      </a.AdminGate>
    ),
  })),
);
// The organisation console (org admins and managers) is its own chunk too; OrgGate stays inside it. The
// invitation page stays in the entry chunk: it is public, opened signed out, outside AppShell's Suspense.
const OrgRoute = lazy(() =>
  import("./pages/OrgPage").then((m) => ({
    default: () => (
      <m.OrgGate>
        <m.OrgLayout />
      </m.OrgGate>
    ),
  })),
);
const OrgNewPage = lazy(() => import("./pages/OrgPage").then((m) => ({ default: m.OrgNewPage })));
const OrgOverviewPage = lazy(() => import("./pages/OrgPage").then((m) => ({ default: m.OrgOverviewPage })));
const OrgPeoplePage = lazy(() => import("./pages/OrgPage").then((m) => ({ default: m.OrgPeoplePage })));
const OrgInvitePage = lazy(() => import("./pages/OrgPage").then((m) => ({ default: m.OrgInvitePage })));
const OrgMemberPage = lazy(() => import("./pages/OrgPage").then((m) => ({ default: m.OrgMemberPage })));
const OrgSettingsPage = lazy(() => import("./pages/OrgPage").then((m) => ({ default: m.OrgSettingsPage })));
const OrgAuditPage = lazy(() => import("./pages/OrgPage").then((m) => ({ default: m.OrgAuditPage })));

// Another ThreatReady app sent the browser here to sign in: remember where to return.
captureNext();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AuthPage />} />
        <Route path="/signout" element={<SignOutPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/app" element={<AppShell />}>
          <Route index element={<ProductPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="admin" element={<AdminRoute />} />
          <Route path="admin/users/:id" element={<AdminUserRoute />} />
          <Route path="admin/orgs" element={<AdminOrgsRoute />} />
          <Route path="admin/orgs/:id" element={<AdminOrgRoute />} />
          <Route path="org/new" element={<OrgNewPage />} />
          <Route path="org" element={<OrgRoute />}>
            <Route index element={<OrgOverviewPage />} />
            <Route path="people" element={<OrgPeoplePage />} />
            <Route path="invite" element={<OrgInvitePage />} />
            <Route path="members/:id" element={<OrgMemberPage />} />
            <Route path="settings" element={<OrgSettingsPage />} />
            <Route path="audit" element={<OrgAuditPage />} />
          </Route>
          <Route path=":feature" element={<ModulePage />} />
        </Route>
        {/* A real not-found page rather than a silent redirect to sign-in (a mistyped or stale link). */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
