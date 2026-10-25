import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CreateInterviewPage from '../src/features/interview-prep/pages/CreateInterviewPage';

const RID = '11111111-1111-4111-8111-111111111111';
const JID = '22222222-2222-4222-8222-222222222222';
const now = new Date().toISOString();
const doc = (id: string, kind: 'resume' | 'jd', source: 'upload' | 'pasted') => ({
  id, kind, status: 'extracted', source, contentType: null, sizeBytes: source === 'upload' ? 151_552 : null, pageCount: source === 'upload' ? 2 : null,
  extractedText: 'Experienced security analyst. '.repeat(20), editedByUser: false, redactions: { email: 1 }, warnings: [], failureCode: null, createdAt: now,
});

/** The API, by method and path. `platform` and `list` vary per test. */
function mockApi({ platform = { apps: [] } as object, list = true } = {}) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (path === '/v1/platform') return Response.json(platform);
    if (path === '/v1/documents' && method === 'GET') return list ? Response.json({ items: [] }) : Response.json({ error: { code: 'NOT_FOUND', message: 'Not found', request_id: 'r', retryable: false } }, { status: 404 });
    if (path === `/v1/documents/${RID}` && method === 'GET') return Response.json(doc(RID, 'resume', 'upload'));
    if (path === `/v1/documents/${JID}` && method === 'GET') return Response.json(doc(JID, 'jd', 'pasted'));
    if (path.startsWith('/v1/documents/') && method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('', { status: 404 });
  });
  return calls;
}

let location = '';
function Where() {
  const l = useLocation();
  location = `${l.pathname}${l.search}`;
  return null;
}
const renderAt = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Where />
        {/* As in the app shell: focusMainHeading finds the page's h1 inside <main>. */}
        <main>
          <Routes>
            <Route path="/interview-prep/new" element={<CreateInterviewPage />} />
          </Routes>
        </main>
      </MemoryRouter>
    </QueryClientProvider>,
  );
const consentText = async () => (await screen.findByText('How your data is used')).closest('.card')!.querySelector('ul')!.textContent ?? '';

afterEach(() => vi.restoreAllMocks());

describe('new interview: data-use copy (TR-13)', () => {
  it('names no storage location unless the deployment configures one, and only promises what the UI offers', async () => {
    mockApi({ list: false });
    renderAt(`/interview-prep/new?step=2&resume=${RID}&jd=${JID}`);
    await waitFor(async () => expect(await consentText()).toMatch(/Delete or Replace/));
    const text = await consentText();
    expect(text).not.toMatch(/Mumbai|India/);
    expect(text).not.toMatch(/at any time/);
    expect(text).toMatch(/deleted automatically after 30 days/);
    expect(text).toMatch(/redacted text, and the profile built from it, stay with your account/);
  });

  it('uses the configured location and promises deletion from history once the API lists documents', async () => {
    mockApi({ platform: { apps: [], dataHandling: { storageLocation: 'Singapore', fileRetentionDays: 14 } }, list: true });
    renderAt(`/interview-prep/new?step=2&resume=${RID}&jd=${JID}`);
    await waitFor(async () => expect(await consentText()).toMatch(/at any time from your interview history/));
    expect(await consentText()).toMatch(/Your documents are stored in Singapore\./);
    expect(await consentText()).toMatch(/deleted automatically after 14 days/);
  });
});

describe('new interview: wizard state (TR-53)', () => {
  it('restores step 2 and the documents from the URL; Back stays in the wizard and keeps the resume', async () => {
    window.sessionStorage.setItem(`tr:doc-name:${RID}`, 'asha-rao-cv.pdf');
    mockApi();
    renderAt(`/interview-prep/new?step=2&resume=${RID}&jd=${JID}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Add the job you are targeting' })).toBeInTheDocument();
    expect(await screen.findByText('Pasted text')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Start with your resume' })).toBeInTheDocument();
    // The uploaded resume is still there, under its file name, and still in the URL.
    expect(screen.getByText('asha-rao-cv.pdf')).toBeInTheDocument();
    expect(location).toContain(`resume=${RID}`);
    expect(location).not.toContain('step=2');
    expect(screen.getByRole('button', { name: /Continue/ })).toBeEnabled();
  });
});

describe('new interview: deleting documents (TR-13)', () => {
  it('Delete removes the resume on the server and returns to the upload, with focus on it', async () => {
    const calls = mockApi();
    renderAt(`/interview-prep/new?resume=${RID}`);
    const row = (await screen.findByText('2 pages', { exact: false })).closest('.file-row') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    const upload = await screen.findByRole('button', { name: 'Drag your resume here, or click to browse' });
    expect(calls).toContain(`DELETE /v1/documents/${RID}`);
    expect(upload).toHaveFocus();
    // The router applies the URL change in a transition, just after the screen updates.
    await waitFor(() => expect(location).not.toContain('resume='));
  });

  it('Replace deletes the document it replaces', async () => {
    const calls = mockApi();
    renderAt(`/interview-prep/new?step=2&resume=${RID}&jd=${JID}`);
    const row = (await screen.findByText('Pasted text')).closest('.file-row') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Replace' }));
    expect(await screen.findByRole('textbox', { name: 'Paste the job description' })).toBeInTheDocument();
    expect(calls).toContain(`DELETE /v1/documents/${JID}`);
  });

  it('a failed Delete keeps the document and says why', async () => {
    mockApi();
    const f = vi.mocked(globalThis.fetch);
    const base = f.getMockImplementation()!;
    f.mockImplementation(async (input, init) =>
      init?.method === 'DELETE'
        ? Response.json({ error: { code: 'INTERVIEW_INVALID_STATE', message: 'This document is used by an interview in progress', request_id: 'req_1', retryable: false } }, { status: 409 })
        : base(input, init),
    );
    renderAt(`/interview-prep/new?resume=${RID}`);
    const row = (await screen.findByText('2 pages', { exact: false })).closest('.file-row') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('The resume was not deleted')).toBeInTheDocument();
    expect(screen.getByText('This document is used by an interview in progress')).toBeInTheDocument();
    expect(screen.getByText('2 pages', { exact: false })).toBeInTheDocument();
  });
});

describe('upload drop zone accessibility (TR-54 / UI-7)', () => {
  it('has one control, a button named by its visible text; the file input is hidden and never nested in a button', async () => {
    mockApi();
    const { container } = renderAt('/interview-prep/new');
    const button = await screen.findByRole('button', { name: 'Drag your resume here, or click to browse' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAccessibleDescription(/PDF or DOCX, up to 5 MB/);
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    expect(input.hidden).toBe(true);
    expect(container.querySelector('[role=button] input, button input')).toBeNull();
    expect(container.querySelector('.dropzone')).not.toHaveAttribute('role');
    expect(container.querySelector('.dropzone')).not.toHaveAttribute('aria-label');
    // Keyboard and click both open the file chooser through the hidden input.
    const click = vi.spyOn(input, 'click');
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(click).toHaveBeenCalledTimes(1);
  });
});
