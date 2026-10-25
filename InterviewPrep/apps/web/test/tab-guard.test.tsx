import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionView } from '@threatready/contracts';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InterviewRoom from '../src/features/interview-prep/components/InterviewRoom';

const now = new Date().toISOString();
const base: SessionView = {
  id: '44444444-4444-4444-8444-444444444444',
  state: 'awaiting_answer',
  interviewerStatus: 'listening',
  roleTitle: 'SOC Analyst (L2)',
  config: { interviewType: 'mixed', difficulty: 'intermediate', durationMin: 30, mode: 'realistic', track: 'soc_analyst', focusSkillIds: [], speakQuestions: false, voiceAnswers: false },
  progress: { questionNumber: 1, plannedQuestions: 8, turnsUsed: 1, maxTurns: 12 },
  timing: { durationSec: 1800, activeElapsedSec: 60, remainingSec: 1740, serverNow: now, runningSince: now },
  currentTurn: { turnId: '55555555-5555-4555-8555-555555555555', seq: 1, kind: 'question', questionNumber: 1, topic: 'Alert triage', question: 'How do you triage a phishing report?', answer: null, askedAt: now, answeredAt: null, practiceFeedback: null, clarifications: [] },
  transcript: [],
  report: { status: 'none', overallScore: null },
  failure: null,
  createdAt: now,
  startedAt: now,
  completedAt: null,
  endReason: null,
};

const renderRoom = (session: SessionView) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <InterviewRoom initial={session} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

/** POST …/tab-hidden: 204 from an API that records switches, 404 from an older one. */
let tabHiddenStatus = 204;
let tabHiddenCalls = 0;
beforeEach(() => {
  tabHiddenStatus = 204;
  tabHiddenCalls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/tab-hidden') && init?.method === 'POST') {
      tabHiddenCalls++;
      return tabHiddenStatus === 204 ? new Response(null, { status: 204 }) : Response.json({ error: { code: 'NOT_FOUND', message: 'Cannot POST', request_id: 'r', retryable: false } }, { status: 404 });
    }
    return new Response('', { status: 404 });
  });
});

afterEach(() => {
  setVisibility('visible');
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('tab-switch guard', () => {
  it('warns when the candidate comes back after switching tabs, and counts repeats', async () => {
    tabHiddenStatus = 404; // an API that does not record switches: the reminder never claims it is recorded
    renderRoom(base);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    setVisibility('hidden');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    setVisibility('visible');
    // A neutral reminder, not a ban: it says the score is unaffected.
    const dialog = screen.getByRole('dialog', { name: /switched away from the interview/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent(/doesn’t affect your score/);
    expect(dialog).not.toHaveTextContent(/times./);
    expect(screen.getByRole('button', { name: 'Back to the interview' })).toHaveFocus();
    // Focus stays inside the dialog.
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Back to the interview' })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Back to the interview' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    setVisibility('hidden');
    setVisibility('visible');
    expect(screen.getByRole('dialog')).toHaveTextContent('You have switched away 2 times.');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('records each switch with the API on return, and then says the report notes it (TR-24)', async () => {
    renderRoom(base);
    setVisibility('hidden');
    expect(tabHiddenCalls).toBe(0);
    setVisibility('visible');
    await waitFor(() => expect(tabHiddenCalls).toBe(1));
    const [url, init] = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/tab-hidden'))!;
    expect(url).toBe(`/v1/interviews/${base.id}/tab-hidden`);
    expect(JSON.parse(String(init!.body))).toEqual({ hiddenMs: expect.any(Number) });
    const dialog = screen.getByRole('dialog', { name: /switched away from the interview/i });
    await waitFor(() => expect(dialog).toHaveTextContent(/doesn’t affect your score; your report notes how often you switched away/));
    expect(dialog).not.toHaveTextContent(/not allowed|reminder only/);
  });

  it('an older API without the endpoint (404) leaves the plain reminder', async () => {
    tabHiddenStatus = 404;
    renderRoom(base);
    setVisibility('hidden');
    setVisibility('visible');
    await waitFor(() => expect(tabHiddenCalls).toBe(1));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('This is a reminder only; it doesn’t affect your score.'));
    expect(screen.getByRole('dialog')).not.toHaveTextContent(/report/);
  });

  it('asks before the page is closed or reloaded mid-interview', () => {
    renderRoom(base);
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('stays quiet before the interview starts and while paused', () => {
    const { unmount } = renderRoom({ ...base, state: 'planned', currentTurn: null });
    setVisibility('hidden');
    setVisibility('visible');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    unmount();

    renderRoom({ ...base, state: 'paused' });
    setVisibility('hidden');
    setVisibility('visible');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(tabHiddenCalls).toBe(0);
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('paused interview (TR-24)', () => {
  it('keeps the question off screen while paused, including the transcript', async () => {
    const asked = { ...base.currentTurn!, question: 'How do you triage a phishing report?' };
    renderRoom({ ...base, state: 'paused', currentTurn: asked, transcript: [asked] });
    expect(screen.getByRole('heading', { name: 'Interview paused' })).toBeInTheDocument();
    expect(screen.getByText(/question is hidden while the interview is paused/)).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /Transcript/ });
    if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
    expect(screen.queryByText(/How do you triage a phishing report/)).not.toBeInTheDocument();
  });

  it('shows the question again once resumed', () => {
    renderRoom(base);
    expect(screen.getByText('How do you triage a phishing report?')).toBeInTheDocument();
  });
});
