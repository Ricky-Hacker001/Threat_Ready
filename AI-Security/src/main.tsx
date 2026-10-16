import React from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "@/state/store";
import App from "@/App";
import { setProgressNamespace } from "@/engine/progress";
import { platformUser } from "@/platform";
import "@/styles/theme.css";

// Inside ThreatReady, progress is kept per signed-in account; the namespace must be known before
// the store first reads it (standalone this resolves at once with no user).
void platformUser().then((user) => {
  if (user) setProgressNamespace(user.id);
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </React.StrictMode>,
  );
});
