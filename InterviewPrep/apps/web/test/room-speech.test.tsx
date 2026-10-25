import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionView } from '@threatready/contracts';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InterviewRoom from '../src/features/interview-prep/components/InterviewRoom';

const now = new Date().toISOString();
const QUESTION = 'How would you contain a compromised mailbox?';
const CLAR = { question: 'Which mail platform?', answer: 'Assume Microsoft 365.', at: now };
const turn = { turnId: '66666666-6666-4666-8666-666666666666', seq: 1, kind: 'question' as const, questionNumber: 1, topic: 'Incident response', question: QUESTION, answer: null, askedAt: now, answeredAt: null, practiceFeedback: null, clarifications: [CLAR] };
const live: SessionView = {
  id: '77777777-7777-4777-8777-777777777777',
  state: 'awaiting_answer',
  interviewerStatus: 'listening',
  roleTitle: 'SOC Analyst (L2)',
  config: { interviewType: 'mixed', difficulty: 'intermediate', durationMin: 30, mode: 'realistic', track: 'soc_analyst', focusSkillIds: [], speakQuestions: true, voiceAnswers: false },
  progress: { questionNumber: 1, plannedQuestions: 8, turnsUsed: 1, maxTurns: 12 },
  timing: { durationSec: 1800, activeElapsedSec: 60, remainingSec: 1740, serverNow: now, runningSince: now },
  currentTurn: turn,
  transcript: [turn],
  report: { status: 'none', overallScore: null },
  failure: null,
  createdAt: now,
  startedAt: now,
  completedAt: null,
  endReason: null,
};
/** What IPAPI answers while paused: the question and its clarifications are withheld (TR-24). */
const hidden = { ...turn, question: '', clarifications: [], questionHidden: true };
const paused: SessionView = { ...live, state: 'paused', interviewerStatus: 'paused', timing: { ...live.timing, runningSince: null }, currentTurn: hidden, transcript: [hidden] };

/** speechSynthesis stand-in: records what Alex says; `cancel` interrupts, so the last utterance is what is heard. */
let said: string[] = [];
beforeEach(() => {
  said = [];
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class { onstart: (() => void) | null = null; constructor(readonly text: string) {} } });
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      speak: (u: { text: string; onstart: (() => void) | null }) => { said.push(u.text); u.onstart?.(); },
      cancel: () => {},
      getVoices: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    if (path.endsWith('/pause') && init?.method === 'POST') return Response.json(paused);
    if (path.endsWith('/resume') && init?.method === 'POST') return Response.json(live);
    return new Response('', { status: 404 });
  });
});
afterEach(() => {
  cleanup(); // unmount (Alex stops speaking) before the stand-in goes
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
  delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
  vi.restoreAllMocks();
});

const renderRoom = (s: SessionView) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <InterviewRoom initial={s} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('what Alex reads out', () => {
  it('reads the question, not an earlier clarification reply, when the room opens with clarifications', async () => {
    renderRoom(live);
    await waitFor(() => expect(said.length).toBeGreaterThan(0));
    expect(said.join(' ')).toContain('contain a compromised mailbox');
    expect(said.join(' ')).not.toContain(CLAR.answer);
  });

  it('after pause and resume, the last thing said is the question again (the API withheld the clarifications while paused)', async () => {
    renderRoom(live);
    await waitFor(() => expect(said.length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole('button', { name: /Pause the interview/ }));
    await screen.findByRole('heading', { name: 'Interview paused' });
    said = [];
    await userEvent.click(screen.getByRole('button', { name: /Resume interview/ }));
    await waitFor(() => expect(said.length).toBeGreaterThan(0));
    // Give any later effect a chance to speak over the question.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(said.join(' ')).not.toContain(CLAR.answer);
    expect(said.at(-1)).toMatch(/contain a compromised mailbox\?$/);
  });

  it('still reads out a new clarification reply that arrives while answering', async () => {
    const before = { ...turn, clarifications: [] };
    renderRoom({ ...live, currentTurn: before, transcript: [before] });
    await waitFor(() => expect(said.length).toBeGreaterThan(0));
    said = [];
    // The reply comes back on the stream as a new session view (same turn, one more clarification).
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/clarify') && init?.method === 'POST') {
        const body = `data: ${JSON.stringify({ type: 'done', session: live })}\n\n`;
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response('', { status: 404 });
    });
    await userEvent.click(screen.getByRole('button', { name: /Ask Alex/ }));
    await userEvent.click(screen.getByRole('textbox', { name: 'Your question for Alex' }));
    await userEvent.paste(CLAR.question);
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(said).toContain(CLAR.answer));
  });
});
