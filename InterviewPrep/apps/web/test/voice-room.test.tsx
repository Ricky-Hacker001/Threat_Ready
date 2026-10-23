import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionView } from '@threatready/contracts';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InterviewRoom from '../src/features/interview-prep/components/InterviewRoom';

/** A controllable stand-in for the browser's SpeechRecognition. */
class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
  }
  abort() {
    this.started = false;
  }
  say(text: string) {
    this.onresult?.({ resultIndex: 0, results: { length: 1, 0: { isFinal: true, 0: { transcript: text } } } });
  }
  hear(text: string) {
    this.onresult?.({ resultIndex: 0, results: { length: 1, 0: { isFinal: false, 0: { transcript: text } } } });
  }
  /** The engine ends the session on its own (silence or time limit). */
  end() {
    this.onend?.();
  }
}

const session = (voice: boolean): SessionView => ({
  id: '11111111-1111-4111-8111-111111111111',
  state: 'awaiting_answer',
  interviewerStatus: 'listening',
  roleTitle: 'SOC Analyst',
  config: { interviewType: 'mixed', difficulty: 'beginner', durationMin: 15, mode: 'realistic', track: 'soc_analyst', focusSkillIds: [], speakQuestions: false, voiceAnswers: voice },
  progress: { questionNumber: 2, plannedQuestions: 5, turnsUsed: 2, maxTurns: 7 },
  timing: { durationSec: 900, activeElapsedSec: 60, remainingSec: 840, serverNow: new Date().toISOString(), runningSince: new Date().toISOString() },
  currentTurn: {
    turnId: '22222222-2222-4222-8222-222222222222',
    seq: 2,
    kind: 'question',
    questionNumber: 2,
    topic: 'Alert triage',
    question: 'How would you triage a burst of failed logins?',
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
});

function renderRoom(s: SessionView) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <InterviewRoom initial={s} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const sse = (events: object[]) =>
  new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });

beforeEach(() => {
  (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = FakeRecognition;
});
afterEach(() => {
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  FakeRecognition.last = null;
  vi.restoreAllMocks();
});

describe('voice interview', () => {
  it('opens the microphone for the answer and fills the answer box with what the candidate says', async () => {
    renderRoom(session(true));
    expect(screen.getByText('Voice interview')).toBeInTheDocument();
    await waitFor(() => expect(FakeRecognition.last?.started).toBe(true));
    act(() => FakeRecognition.last!.say('I would check the source IPs'));
    act(() => FakeRecognition.last!.say('and look for password spraying'));
    expect(screen.getByLabelText('Your answer')).toHaveValue('I would check the source IPs and look for password spraying');
    expect(screen.getByText(/Listening… speak your answer/)).toBeInTheDocument();
  });

  it('keeps words still being transcribed when the browser restarts recognition', async () => {
    renderRoom(session(true));
    await waitFor(() => expect(FakeRecognition.last?.started).toBe(true));
    act(() => FakeRecognition.last!.say('first I would pull the sim alerts'));
    act(() => FakeRecognition.last!.hear('then check the e d r telemetry'));
    act(() => FakeRecognition.last!.end());
    expect(screen.getByLabelText('Your answer')).toHaveValue('First I would pull the SIEM alerts then check the EDR telemetry');
  });

  it('submits the words still being transcribed instead of dropping them', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'done', session: session(true) }]));
    renderRoom(session(true));
    await waitFor(() => expect(FakeRecognition.last?.started).toBe(true));
    act(() => FakeRecognition.last!.say('I would check the source IPs for a single origin'));
    act(() => FakeRecognition.last!.hear('and map it to mitre attack'));
    await userEvent.click(screen.getByRole('button', { name: /Submit answer/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.answer).toBe('I would check the source IPs for a single origin and map it to MITRE ATT&CK');
  });

  it('lets the candidate choose their accent for recognition', async () => {
    renderRoom(session(true));
    await waitFor(() => expect(FakeRecognition.last?.started).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: /Answer options/ }));
    await userEvent.selectOptions(screen.getByLabelText('Your accent'), 'en-IN');
    await waitFor(() => expect(FakeRecognition.last?.lang).toBe('en-IN'));
  });

  it('keeps auto-submit off until the candidate opts in, with a pause they choose', async () => {
    renderRoom(session(true));
    await waitFor(() => expect(FakeRecognition.last?.started).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: /Answer options/ }));
    const auto = screen.getByRole('checkbox', { name: /Submit my answer automatically/ });
    expect(auto).not.toBeChecked();
    await userEvent.click(auto);
    await userEvent.selectOptions(screen.getByLabelText('After a pause of'), '20');
    expect(JSON.parse(localStorage.getItem('tr:voice:autosubmit')!)).toEqual({ on: true, silenceSec: 20 });
  });

  it('explains a missing microphone and switches to typing', async () => {
    renderRoom(session(true));
    await waitFor(() => expect(FakeRecognition.last?.started).toBe(true));
    act(() => FakeRecognition.last!.onerror?.({ error: 'audio-capture' }));
    expect(screen.queryByText('Voice interview')).not.toBeInTheDocument();
    expect(screen.getByText('Typing mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Your answer')).toBeEnabled();
  });

  it('falls back to typing when voice is not supported by the browser', () => {
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    renderRoom(session(true));
    expect(screen.queryByText('Voice interview')).not.toBeInTheDocument();
    expect(screen.getByText('Voice answers aren’t supported in this browser')).toBeInTheDocument();
    expect(screen.getByLabelText('Your answer')).toBeEnabled();
  });
});

describe('real-interview interactions', () => {
  it('nudges before submitting a very short answer, and submits on "Submit anyway"', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'done', session: session(false) }]));
    renderRoom(session(false));
    await userEvent.type(screen.getByLabelText('Your answer'), 'none');
    await userEvent.click(screen.getByRole('button', { name: /Submit answer/ }));
    expect(screen.getByText(/That's a short answer/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Submit anyway' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('lets the candidate ask Alex a clarifying question and shows the reply', async () => {
    const s = session(false);
    const withClar = { ...s, currentTurn: { ...s.currentTurn!, clarifications: [{ question: 'Is this on a VPN?', answer: 'Assume the logins come from the internet.', at: new Date().toISOString() }] } };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sse([{ type: 'reply.delta', text: 'Assume the logins come from the internet.' }, { type: 'done', session: withClar }]));
    renderRoom(s);
    await userEvent.click(screen.getByRole('button', { name: /Ask Alex/ }));
    await userEvent.type(screen.getByLabelText('Your question for Alex'), 'Is this on a VPN?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(screen.getAllByText(/Assume the logins come from the internet/).length).toBeGreaterThan(0));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/v1/interviews/${s.id}/clarify`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ turnId: s.currentTurn!.turnId, message: 'Is this on a VPN?' });
  });
});
