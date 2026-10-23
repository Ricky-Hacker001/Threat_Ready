import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initStorageNamespace } from './store';
import { LABS } from './content/labs';
import { prepareCartTests } from './content/aeroshop';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

// Before the first render: the account namespace for saved progress, and the unit-test sandbox
// outcomes for every lab's starting cart.js (some labs run their first pipeline as the lab opens).
// The sandbox normally answers in well under a second; never hold the app for longer than this.
const seedCarts = LABS.flatMap((l) => {
  const seed = l.seed();
  return [...seed.history.map((h) => h.files['src/lib/cart.js']), seed.local?.['src/lib/cart.js']];
});
const warm = Promise.race([prepareCartTests(seedCarts), new Promise((r) => setTimeout(r, 3000))]);
void Promise.all([initStorageNamespace(), warm]).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
