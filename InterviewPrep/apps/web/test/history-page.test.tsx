import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HistoryPage from '../src/features/interview-prep/pages/HistoryPage';
import { CardSkeleton } from '../src/ui/components';

const now = new Date().toISOString();
const RID = '11111111-1111-4111-8111-111111111111';
const doc = { status: 'extracted', contentType: null, fileDeleted: false, inUse: false, createdAt: now };
const docs = [
  { ...doc, id: RID, kind: 'resume', source: 'upload', sizeBytes: 1000, pageCount: 2 },
  { ...doc, id: '22222222-2222-4222-8222-222222222222', kind: 'jd', source: 'pasted', sizeBytes: null, pageCount: null },
  { ...doc, id: '44444444-4444-4444-8444-444444444444', kind: 'resume', source: 'upload', sizeBytes: 1000, pageCount: 1, inUse: true },
];
const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <HistoryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('history page states', () => {
  it('a failed load shows the error only, never "No interviews yet" as well (TR-56)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).startsWith('/v1/interviews')
        ? Response.json({ error: { code: 'VALIDATION_FAILED', message: 'Some fields are invalid', request_id: 'r', retryable: false } }, { status: 422 })
        : Response.json({ items: [] }),
    );
    renderPage();
    expect(await screen.findByText('Some fields are invalid')).toBeInTheDocument();
    expect(screen.queryByText('No interviews yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Start your first interview')).not.toBeInTheDocument();
  });

  it('lists the learner’s documents with Delete, confirmed first (TR-13)', async () => {
    const calls: string[] = [];
    let list = docs;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      if (path.startsWith('/v1/interviews')) return Response.json({ items: [], nextCursor: null });
      if (path === '/v1/documents') return Response.json({ items: list });
      if (method === 'DELETE') {
        list = list.filter((d) => !path.endsWith(d.id));
        return new Response(null, { status: 204 });
      }
      return new Response('', { status: 404 });
    });
    renderPage();
    const section = (await screen.findByRole('heading', { name: 'Your documents' })).closest('section') as HTMLElement;
    expect(within(section).getAllByText('Resume (uploaded file)')).toHaveLength(2);
    // A document an interview in progress uses can't be deleted yet: no button, a reason instead.
    expect(within(section).getByText('In use by an interview in progress')).toBeInTheDocument();
    expect(within(section).getAllByRole('button', { name: /^Delete / })).toHaveLength(2);
    expect(within(section).getByText('Job description (pasted text)')).toBeInTheDocument();
    await userEvent.click(within(section).getAllByRole('button', { name: 'Delete Resume (uploaded file)' })[0]!);
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false); // asks first
    await userEvent.click(within(section).getByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(within(section).getAllByText('Resume (uploaded file)')).toHaveLength(1));
    expect(calls).toContain(`DELETE /v1/documents/${RID}`);
  });

  it('hides the documents list when the API has none (older API)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input) === '/v1/documents'
        ? Response.json({ error: { code: 'NOT_FOUND', message: 'Cannot GET /v1/documents', request_id: 'r', retryable: false } }, { status: 404 })
        : Response.json({ items: [], nextCursor: null }),
    );
    renderPage();
    expect(await screen.findByText('No interviews yet')).toBeInTheDocument();
    // The empty state sits directly under the page's h1, so its title is an h2 (no skipped heading level).
    expect(screen.getByRole('heading', { level: 2, name: 'No interviews yet' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('heading', { name: 'Your documents' })).not.toBeInTheDocument();
  });
});

describe('loading skeleton (UI-14)', () => {
  it('is a named status region, with no aria-label on a role-less element', () => {
    const { container } = render(<CardSkeleton label="Loading your interviews" />);
    const status = screen.getByRole('status', { name: 'Loading your interviews' });
    expect(status).toHaveTextContent('Loading your interviews…');
    expect(status).not.toHaveAttribute('aria-busy');
    for (const el of container.querySelectorAll('[aria-label]')) expect(el.getAttribute('role')).toBeTruthy();
  });
});
