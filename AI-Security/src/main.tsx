import React from "react";
import { createRoot } from "react-dom/client";
import { AppProvider } from "@/state/store";
import App from "@/App";
import { setProgressNamespace, setSessionOnlyStorage } from "@/engine/progress";
import { inPlatform, platformUser, waitText } from "@/platform";
import { BRAND } from "@/brand/brand";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@/styles/theme.css";

const root = createRoot(document.getElementById("root")!);

// While ThreatReady confirms who is signed in (a few seconds at most), show that the lab is opening.
const boot = (text: string) =>
  root.render(
    <div className="boot" role="status">
      <img src={BRAND.logoWhite} alt="" width="26" height="25" />
      <h1>{BRAND.productName}</h1>
      <p className="muted">{text}</p>
    </div>,
  );
if (inPlatform) boot("Opening your lab…");

// Inside ThreatReady, progress is kept per signed-in account; the namespace must be known before
// the store first reads it (standalone this resolves at once with no user). If the account can't be
// confirmed, progress is kept for this tab only — never under the shared key — and the lab says so.
const onWait = (seconds: number) => boot(`ThreatReady is busy. Trying again in ${waitText(seconds)}…`);
void platformUser(onWait).then((user) => {
  if (user) setProgressNamespace(user.id);
  else if (inPlatform) setSessionOnlyStorage();
  root.render(
    <React.StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </React.StrictMode>,
  );
});
