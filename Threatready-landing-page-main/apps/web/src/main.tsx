import { lazy, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { AppShell } from "./components/AppShell";
import { captureNext } from "./lib/platform";
import { AuthPage } from "./pages/AuthPage";
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

// Another ThreatReady app sent the browser here to sign in: remember where to return.
captureNext();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AuthPage />} />
        <Route path="/signout" element={<SignOutPage />} />
        <Route path="/app" element={<AppShell />}>
          <Route index element={<ProductPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="admin" element={<AdminRoute />} />
          <Route path="admin/users/:id" element={<AdminUserRoute />} />
          <Route path=":feature" element={<ModulePage />} />
        </Route>
        {/* A real not-found page rather than a silent redirect to sign-in (a mistyped or stale link). */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
