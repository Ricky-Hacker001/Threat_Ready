import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionView } from '@threatready/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReportPage from '../src/features/interview-prep/pages/ReportPage';
import SessionPage from '../src/features/interview-prep/pages/SessionPage';

const ID = '33333333-3333-4333-8333-333333333333';
const now = new Date().toISOString();
const failedScoring = (report: SessionView['report'] = { status: 'failed', overallScore: null }): SessionView => ({
  id: ID,
  state: 'failed',
  interviewerStatus: 'finished',
  roleTitle: 'SOC Analyst (L2)',
  config: null,
  progress: { questionNumber: 3, plannedQuestions: 8, turnsUsed: 3, maxTurns: 12 },
  timing: { durationSec: 1800, activeElapsedSec: 600, remainingSec: 1200, serverNow: now, runningSince: null },
  currentTurn: null,
  transcript: [],
  report,
  failure: { code: 'LLM_PROVIDER_UNAVAILABLE', stage: 'scoring' },
  createdAt: now,
  startedAt: now,
  completedAt: now,
  endReason: 'candidate_ended',
});
const envelope = (code: string, status: number, message = 'server message') => Response.json({ error: { code, message, request_id: 'req_abc', retryable: false } }, { status });

const renderAt = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        {/* As in the app shell: focusMainHeading finds the page's h1 inside <main>. */}
        <main>
          <Routes>
            <Route path="/interview-prep/sessions/:id" element={<SessionPage />} />
            <Route path="/interview-prep/sessions/:id/report" element={<ReportPage />} />
          </Routes>
        </main>
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('stale or bad interview links (UI-12)', () => {
  it('a malformed id shows a not-found page with a way back, without asking the API', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    renderAt('/interview-prep/sessions/not-a-uuid');
    expect(screen.getByRole('heading', { level: 1, name: 'This interview doesn’t exist or isn’t yours' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to interview history' })).toHaveAttribute('href', '/interview-prep/history');
    expect(f).not.toHaveBeenCalled();
    expect(document.title).toMatch(/^Interview not found/);
  });

  it('an unknown or someone else’s interview (404) shows the not-found page, not "Something went wrong"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope('INTERVIEW_SESSION_NOT_FOUND', 404, 'Interview session not found'));
    renderAt(`/interview-prep/sessions/${ID}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'This interview doesn’t exist or isn’t yours' })).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('the report route does the same for an unknown interview', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope('INTERVIEW_SESSION_NOT_FOUND', 404));
    renderAt(`/interview-prep/sessions/${ID}/report`);
    expect(await screen.findByRole('heading', { level: 1, name: 'This report doesn’t exist or isn’t yours' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to interview history' })).toBeInTheDocument();
  });

  it('a server failure still offers Try again', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { code: 'INTERNAL_ERROR', message: 'x', request_id: 'r', retryable: true } }, { status: 500 }));
    renderAt(`/interview-prep/sessions/${ID}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Your interview could not be loaded' }, { timeout: 8_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('report retry cap (UX-REG4)', () => {
  it('when the cap is reached, the retry button goes and the page says to contact support (older API code)', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) =>
      init?.method === 'POST'
        ? envelope('INTERVIEW_LIMIT_REACHED', 409, 'The report has been retried the maximum number of times; contact support')
        : Response.json(failedScoring()),
    );
    renderAt(`/interview-prep/sessions/${ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Generate report again' }));
    expect(await screen.findByText(/could not generate this report after several tries/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate report again' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Finish or cancel an open interview/)).not.toBeInTheDocument();
    expect(screen.getByText(ID)).toBeInTheDocument(); // the reference to quote
    expect(f).toHaveBeenCalledWith(`/v1/interviews/${ID}/report/retry`, expect.objectContaining({ method: 'POST' }));
  });

  it('the new REPORT_RETRY_LIMIT_REACHED code is handled the same way', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      init?.method === 'POST' ? envelope('REPORT_RETRY_LIMIT_REACHED', 409) : Response.json(failedScoring()),
    );
    renderAt(`/interview-prep/sessions/${ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Generate report again' }));
    expect(await screen.findByText(/Contact support and quote the reference below/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate report again' })).not.toBeInTheDocument();
  });

  it('a report stopped by the daily AI budget says it will be generated after 00:00 UTC, with no retry button', async () => {
    const paused: SessionView = { ...failedScoring(), failure: { code: 'AI_SERVICE_PAUSED', stage: 'scoring' } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(paused));
    renderAt(`/interview-prep/sessions/${ID}`);
    expect(await screen.findByRole('heading', { name: 'Your report will be generated later' })).toBeInTheDocument();
    expect(screen.getByText(/paused until 00:00 UTC .* generated automatically/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate report again' })).not.toBeInTheDocument();
    expect(screen.queryByText(/after several tries/)).not.toBeInTheDocument();
  });

  it('hides the button up front when the API says no retries are left', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(failedScoring({ status: 'failed', overallScore: null, retriesLeft: 0 })));
    renderAt(`/interview-prep/sessions/${ID}`);
    expect(await screen.findByRole('heading', { name: 'The report could not be generated' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate report again' })).not.toBeInTheDocument();
    expect(screen.getByText(/after several tries/)).toBeInTheDocument();
  });
});
