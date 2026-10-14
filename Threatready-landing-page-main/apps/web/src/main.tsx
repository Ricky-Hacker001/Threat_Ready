import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/AppShell";
import { captureNext } from "./lib/platform";
import { AdminGate, AdminPage } from "./pages/AdminPage";
import { AdminUserPage } from "./pages/AdminUserPage";
import { AuthPage } from "./pages/AuthPage";
import { ModulePage } from "./pages/ModulePage";
import { ProductPage } from "./pages/ProductPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SignOutPage } from "./pages/SignOutPage";
import "./styles/app.css";

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
          <Route
            path="admin"
            element={
              <AdminGate>
                <AdminPage />
              </AdminGate>
            }
          />
          <Route
            path="admin/users/:id"
            element={
              <AdminGate>
                <AdminUserPage />
              </AdminGate>
            }
          />
          <Route path=":feature" element={<ModulePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
