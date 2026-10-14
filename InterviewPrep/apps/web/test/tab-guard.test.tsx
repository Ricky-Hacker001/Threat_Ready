import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionView } from '@threatready/contracts';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(() => {
  setVisibility('visible');
  sessionStorage.clear();
});

describe('tab-switch guard', () => {
  it('warns when the candidate comes back after switching tabs, and counts repeats', async () => {
    renderRoom(base);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    setVisibility('hidden');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    setVisibility('visible');
    const dialog = screen.getByRole('alertdialog', { name: /not allowed to switch tabs/i });
    expect(dialog).not.toHaveTextContent(/left the interview/);
    expect(screen.getByRole('button', { name: 'Return to the interview' })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Return to the interview' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    setVisibility('hidden');
    setVisibility('visible');
    expect(screen.getByRole('alertdialog')).toHaveTextContent('You have left the interview 2 times.');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
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
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    unmount();

    renderRoom({ ...base, state: 'paused' });
    setVisibility('hidden');
    setVisibility('visible');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
