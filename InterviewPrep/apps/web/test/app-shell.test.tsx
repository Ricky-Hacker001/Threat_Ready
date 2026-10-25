import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/App';
import { PlatformHeader } from '../src/app/PlatformShell';
import { ApiError } from '../src/lib/api';

const me = { id: 'u1', name: 'Asha Rao', email: 'asha@example.test', image: null, isAdmin: false };
const dashboard = { completedCount: 0, averageScore: null, skillsDemonstrated: [], skillsToImprove: [], resumable: [], recent: [], scoreHistory: [], usage: { interviewsThisMonth: 0, monthlyQuota: 10 } };

// Same defaults as main.tsx.
const client = () => new QueryClient({ defaultOptions: { queries: { retry: (count, err) => !(err instanceof ApiError) && count < 1, refetchOnWindowFocus: false, staleTime: 5_000 } } });
const renderApp = () =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={['/interview-prep']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('app shell when the API is unreachable (TR-31)', () => {
  it('shows an error with "Try again" instead of an endless loader, without hammering /v1/me', async () => {
    let meCalls = 0;
    let up = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/me')) meCalls++;
      if (!up) throw new TypeError('Failed to fetch');
      if (url.endsWith('/v1/me')) return Response.json(me);
      if (url.endsWith('/v1/platform')) return Response.json({ apps: [] });
      if (url.endsWith('/v1/interview-prep/dashboard')) return Response.json(dashboard);
      return new Response('', { status: 404 });
    });
    renderApp();
    expect(await screen.findByRole('button', { name: 'Try again' }, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'InterviewPrep couldn’t open' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/could not reach ThreatReady/);
    // It stays on the error: no remount loop re-asking a server that is down.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(meCalls).toBeLessThanOrEqual(3);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();

    // The API is back: Try again opens the app.
    up = true;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: /Welcome, Asha/ }, { timeout: 20_000 })).toBeInTheDocument();
    // It waits on purpose (the client's own network retries, 1.5 s of watching) and then loads the lazy
    // dashboard: on a loaded machine that alone has taken over 20 s (TR-63).
  }, 45_000);
});

describe('platform header', () => {
  it('names the brand link starting with its visible text (WCAG 2.5.3)', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ apps: [] }));
    render(
      <QueryClientProvider client={client()}>
        <PlatformHeader user={me} />
      </QueryClientProvider>,
    );
    const brand = screen.getByRole('link', { name: /home$/ });
    const visible = (brand.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(visible).toBe('ThreatReady InterviewPrep');
    expect(brand.getAttribute('aria-label')!.startsWith(visible)).toBe(true);
  });
});
