import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { platformUser } from './platform';
import { migrateLegacyProgress, setStorageNamespace } from './store';
import { LABS } from './content/labs';
import { prepareCartTests } from './content/aeroshop';
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
// Also before the first render: the unit-test sandbox outcomes for every lab's starting cart.js (some labs run
// their first pipeline as the lab opens). The sandbox normally answers in well under a second; never hold the
// app for longer than this.
const seedCarts = LABS.flatMap((l) => {
  const seed = l.seed();
  return [...seed.history.map((h) => h.files['src/lib/cart.js']), seed.local?.['src/lib/cart.js']];
});
const warm = Promise.race([prepareCartTests(seedCarts), new Promise((r) => setTimeout(r, 3000))]);
void Promise.all([platformUser(), warm]).then(([user]) => {
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
