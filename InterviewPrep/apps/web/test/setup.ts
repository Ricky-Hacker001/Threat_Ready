import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import { cancelHeadingFocus } from '../src/ui/components';

// findBy*/waitFor give up after 1 s by default; on a loaded machine (CI, the full suite in parallel) a
// lazy page or a mocked fetch can take longer than that without anything being wrong.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  // focusMainHeading waits up to 3 s for an h1; that wait must not outlive the test (or jsdom).
  cancelHeadingFocus();
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
});
