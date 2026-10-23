import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { platformUser } from './platform';
import { migrateLegacyProgress, setStorageNamespace } from './store';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
// Inside ThreatReady, progress is kept per signed-in account; the namespace must be known before anything is read.
// The lookup times out after a few seconds; standalone it resolves at once with no user.
root.render(
  <div className="boot" role="status">
    Loading the DevSecOps Lab…
  </div>,
);
void platformUser().then((user) => {
  if (user) {
    setStorageNamespace(user.id);
    migrateLegacyProgress();
  }
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
