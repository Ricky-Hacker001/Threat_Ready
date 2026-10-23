import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './app/App';
import { ApiError } from './lib/api';
// Shared ThreatReady shell first; InterviewPrep's component styles build on its tokens.
import './ui/platform.css';
import './ui/theme.css';

/** Keeps the browser's theme-color (address bar on phones) in step with the dark or light theme. */
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  const apply = () => meta?.setAttribute('content', document.documentElement.getAttribute('data-theme') === 'light' ? '#ffffff' : '#0b1020');
  apply();
  new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
syncThemeColor();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The API client already retries retryable failures; do not multiply attempts here.
      retry: (count, err) => !(err instanceof ApiError) && count < 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
