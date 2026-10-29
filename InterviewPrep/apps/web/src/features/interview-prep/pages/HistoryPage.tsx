import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrainCircuit, ChevronRight, Clock, FileText, History, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError, documentsListUnsupported } from '../../../lib/api';
import { relativeTime, STATE_LABEL, titleCase } from '../../../lib/format';
import { Busy, CardSkeleton, Empty, ErrorAlert, ScorePill, usePageTitle, useToast } from '../../../ui/components';
import { recallName } from '../components/DocumentStep';

type Filter = 'all' | 'reports' | 'open';

export default function HistoryPage() {
  usePageTitle('Interview history');
  const [filter, setFilter] = useState<Filter>('all');
  const q = useInfiniteQuery({
    queryKey: ['sessions'],
    queryFn: ({ pageParam }) => api.listSessions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const all = q.data?.pages.flatMap((p) => p.items) ?? [];
  const items = all.filter((s) =>
    filter === 'reports' ? s.state === 'report_ready' : filter === 'open' ? ['parsing', 'profiled', 'planned', 'asking', 'awaiting_answer', 'evaluating', 'paused'].includes(s.state) : true,
  );

  return (
    <div className="page" style={{ maxWidth: 1040 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow"><History className="icon sm" aria-hidden /> InterviewPrep</div>
          <h1>Interview history</h1>
          <p className="subtle" style={{ marginTop: 8 }}>Every session you started, with its report when it is ready.</p>
        </div>
      </div>
      {q.error && <div style={{ marginBottom: 16 }}><ErrorAlert error={q.error} onRetry={() => void q.refetch()} /></div>}

      <div className="segmented" role="group" aria-label="Show" style={{ marginBottom: 16 }}>
        {(['all', 'reports', 'open'] as Filter[]).map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'reports' ? 'Reports' : 'In progress'}
          </button>
        ))}
      </div>
      {/* The list is filtered in the browser, so older sessions only count once they are loaded. */}
      {filter !== 'all' && q.hasNextPage && (
        <p className="hint" role="status" style={{ marginBottom: 12 }}>
          Showing matches from your {all.length} most recent sessions. Load more to include older ones.
        </p>
      )}

      {/* A failed load shows only the error above, never "No interviews yet" as well. */}
      {q.isPending ? (
        <CardSkeleton lines={6} label="Loading your interviews" />
      ) : q.error && all.length === 0 ? null : items.length === 0 ? (
        <Empty
          icon={Sparkles}
          level={2}
          title={all.length === 0 ? 'No interviews yet' : 'Nothing here'}
          action={all.length === 0 ? <Link to="/interview-prep/new" className="btn primary">Start your first interview</Link> : q.hasNextPage ? <LoadMore q={q} /> : undefined}
        >
          {all.length === 0 ? 'Your sessions and reports will appear here.' : q.hasNextPage ? 'None of the sessions loaded so far match. Older sessions may.' : 'No sessions match this filter.'}
        </Empty>
      ) : (
        <div className="card">
          <div className="list stagger">
            {items.map((s) => {
              const st = STATE_LABEL[s.state];
              const href = s.state === 'report_ready' ? `/interview-prep/sessions/${s.id}/report` : `/interview-prep/sessions/${s.id}`;
              return (
                <Link to={href} className="list-item" key={s.id}>
                  <span className={`icon-tile ${s.state === 'report_ready' ? 'ok' : ''}`}>
                    {s.state === 'report_ready' ? <FileText className="icon" aria-hidden /> : <BrainCircuit className="icon" aria-hidden />}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong>{s.roleTitle ?? 'Interview'}</strong>
                    <div className="row wrap tight muted" style={{ fontSize: 13, marginTop: 2 }}>
                      {s.interviewType && <span>{titleCase(s.interviewType)}</span>}
                      {s.difficulty && <span>· {titleCase(s.difficulty)}</span>}
                      {s.durationMin && <span className="row tight">· <Clock className="icon sm" aria-hidden style={{ width: 13, height: 13 }} /> {s.durationMin} min</span>}
                      <span>· {s.questionsAnswered} answered</span>
                      <span>· {relativeTime(s.createdAt)}</span>
                    </div>
                  </div>
                  <span className={`badge ${st.tone}`}>{st.label}</span>
                  <ScorePill score={s.overallScore} />
                  <ChevronRight className="icon sm chev" aria-hidden />
                </Link>
              );
            })}
          </div>
          {q.hasNextPage && <LoadMore q={q} />}
        </div>
      )}
      <YourDocuments />
    </div>
  );
}

/**
 * The learner's documents, each with Delete (newer API: GET /v1/documents). Hidden when the API has no
 * such list, so nothing here depends on it.
 */
function YourDocuments() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['documents'], queryFn: api.listDocuments, retry: false });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (q.isPending || documentsListUnsupported(q.error) || (q.data && !Array.isArray(q.data.items))) return null;
  const items = q.data?.items ?? [];

  async function remove(id: string, what: string) {
    setDeleting(id);
    setError(null);
    try {
      await api.deleteDocument(id).catch((e: unknown) => {
        if (!(e instanceof ApiError && e.status === 404)) throw e; // already gone
      });
      setConfirming(null);
      toast({ tone: 'ok', title: `${what} deleted`, body: 'The file and its extracted text were removed.' });
      await qc.invalidateQueries({ queryKey: ['documents'] });
    } catch (e) {
      setError(e);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="card stack" style={{ marginTop: 22 }} aria-labelledby="your-documents">
      <div>
        <h2 id="your-documents" className="row tight"><FileText className="icon" aria-hidden /> Your documents</h2>
        <p className="subtle" style={{ fontSize: 13.5, marginTop: 4 }}>
          Resumes and job descriptions you added. Deleting one removes its file and its extracted text for good; reports you already have stay. A document an interview in progress uses can be deleted once it ends.
        </p>
      </div>
      {q.error != null && <ErrorAlert error={q.error} title="Your documents could not be loaded" onRetry={() => void q.refetch()} />}
      {error != null && <ErrorAlert error={error} title="The document was not deleted" />}
      {!q.error && items.length === 0 && <p className="muted" style={{ fontSize: 13.5 }}>No documents. Uploads appear here.</p>}
      {items.length > 0 && (
        <div className="list">
          {items.map((d) => {
            const what = d.kind === 'resume' ? 'Resume' : 'Job description';
            const fileName = recallName(d.id);
            const name = fileName ?? (d.source === 'pasted' ? `${what} (pasted text)` : `${what} (uploaded file)`);
            const meta = [
              fileName ? what : null,
              d.pageCount != null ? `${d.pageCount} page${d.pageCount === 1 ? '' : 's'}` : null,
              d.source === 'upload' && d.fileDeleted ? 'original file deleted, text kept' : null,
              relativeTime(d.createdAt),
            ].filter(Boolean).join(' · ');
            return (
              <div className="list-item" key={d.id}>
                <span className="icon-tile"><FileText className="icon" aria-hidden /></span>
                <div style={{ flex: '1 1 12rem', minWidth: 0, overflowWrap: 'anywhere' }}>
                  <strong>{name}</strong>
                  <div className="muted" style={{ fontSize: 13 }}>{meta}</div>
                </div>
                {d.inUse ? (
                  <span className="hint">In use by an interview in progress</span>
                ) : confirming === d.id ? (
                  <div className="row tight wrap" role="group" aria-label={`Delete ${name}?`}>
                    <button className="btn danger sm" type="button" disabled={deleting === d.id} onClick={() => void remove(d.id, what)}>
                      {deleting === d.id ? <Busy label="Deleting…" /> : 'Delete for good'}
                    </button>
                    <button className="btn ghost sm" type="button" onClick={() => setConfirming(null)}>Keep</button>
                  </div>
                ) : (
                  <button className="btn ghost sm" type="button" aria-label={`Delete ${name}`} onClick={() => { setError(null); setConfirming(d.id); }}>
                    <Trash2 className="icon sm" aria-hidden /> Delete
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function LoadMore({ q }: { q: { fetchNextPage: () => unknown; isFetchingNextPage: boolean } }) {
  return (
    <button className="btn ghost" style={{ marginTop: 12 }} type="button" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
      {q.isFetchingNextPage ? <Busy label="Loading…" /> : 'Load more'}
    </button>
  );
}
