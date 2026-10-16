import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionView } from '@threatready/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InterviewRoom from '../src/features/interview-prep/components/InterviewRoom';

const base: SessionView = {
  id: '11111111-1111-4111-8111-111111111111',
  state: 'awaiting_answer',
  interviewerStatus: 'listening',
  roleTitle: 'SOC Analyst (L2)',
  config: { interviewType: 'mixed', difficulty: 'intermediate', durationMin: 30, mode: 'realistic', track: 'soc_analyst', focusSkillIds: [], speakQuestions: false, voiceAnswers: false },
  progress: { questionNumber: 1, plannedQuestions: 8, turnsUsed: 1, maxTurns: 12 },
  timing: { durationSec: 1800, activeElapsedSec: 60, remainingSec: 1740, serverNow: new Date().toISOString(), runningSince: new Date().toISOString() },
  currentTurn: {
    turnId: '22222222-2222-4222-8222-222222222222',
    seq: 1,
    kind: 'question',
    questionNumber: 1,
    topic: 'Alert triage',
    question: 'Walk me through how you triage a password-spraying alert in Splunk.',
    answer: null,
    askedAt: new Date().toISOString(),
    answeredAt: null,
    practiceFeedback: null,
    clarifications: [],
  },
  transcript: [],
  report: { status: 'none', overallScore: null },
  failure: null,
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  completedAt: null,
  endReason: null,
};

function renderRoom(session: SessionView) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <InterviewRoom initial={session} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const sseBody = (events: object[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
        c.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );

afterEach(() => vi.restoreAllMocks());

describe('interview room', () => {
  it('works in text-only mode when WebGL is unavailable, with the question, status, timer and progress', () => {
    renderRoom(base);
    expect(screen.getByText(/Walk me through how you triage/)).toBeInTheDocument();
    expect(screen.getByText('Text-only mode')).toBeInTheDocument();
    expect(screen.getAllByText('Listening').length).toBeGreaterThan(0);
    expect(screen.getByRole('timer')).toHaveTextContent('29:00');
    // The current question only: the planned total is never shown to the candidate.
    const progress = screen.getByLabelText('Progress');
    expect(progress.querySelector('strong')).toHaveTextContent(/^1$/);
    expect(progress).toHaveTextContent('Question');
    expect(progress).toHaveTextContent('0 answered');
    expect(progress).not.toHaveTextContent('/');
    expect(progress).not.toHaveTextContent('8');
    expect(screen.getByLabelText('Your answer')).toBeEnabled();
  });

  it('submits once with a stable idempotency key and applies the next question', async () => {
    const next = { ...base, progress: { ...base.progress, questionNumber: 2 }, currentTurn: { ...base.currentTurn!, turnId: '33333333-3333-4333-8333-333333333333', questionNumber: 2, question: 'How would you escalate it?' } };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseBody([{ type: 'evaluating' }, { type: 'question.start', turnId: next.currentTurn.turnId, kind: 'question', questionNumber: 2, topic: 'Incident response' }, { type: 'question.delta', text: 'How would you escalate it?' }, { type: 'done', session: next }]));
    renderRoom(base);
    await userEvent.type(screen.getByLabelText('Your answer'), 'I would scope the alert first.');
    await userEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    await waitFor(() => expect(screen.getByText('How would you escalate it?')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/v1/interviews/${base.id}/turns`);
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({ turnId: base.currentTurn!.turnId, answer: 'I would scope the alert first.' });
    expect(body.clientSubmissionId).toBe(window.sessionStorage.getItem(`tr:submission:${base.currentTurn!.turnId}`));
  });

  it('after a refresh mid-question, recovers by asking the server to regenerate the stored question', async () => {
    const asking: SessionView = { ...base, state: 'asking', interviewerStatus: 'asking', currentTurn: null };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseBody([{ type: 'done', session: base }]));
    renderRoom(asking);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/v1/interviews/${base.id}/question`, expect.objectContaining({ method: 'POST' })), { timeout: 4000 });
    await waitFor(() => expect(screen.getByText(/Walk me through how you triage/)).toBeInTheDocument());
  });

  it('shows the paused state with a resume control and keeps the answer box out of reach', () => {
    renderRoom({ ...base, state: 'paused', interviewerStatus: 'paused', timing: { ...base.timing, runningSince: null } });
    expect(screen.getByRole('button', { name: 'Resume interview' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Your answer')).not.toBeInTheDocument();
  });
});
