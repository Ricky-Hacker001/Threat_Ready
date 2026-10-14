import { useInfiniteQuery } from '@tanstack/react-query';
import { BrainCircuit, ChevronRight, Clock, FileText, History, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../../lib/api';
import { relativeTime, scoreTone, STATE_LABEL, titleCase } from '../../../lib/format';
import { CardSkeleton, Empty, ErrorAlert } from '../../../ui/components';

type Filter = 'all' | 'reports' | 'open';

export default function HistoryPage() {
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
        <Link to="/interview-prep/new" className="btn primary"><Plus className="icon sm" aria-hidden /> New interview</Link>
      </div>
      {q.error && <ErrorAlert error={q.error} onRetry={() => void q.refetch()} />}

      <div className="segmented" role="tablist" aria-label="Filter" style={{ marginBottom: 16 }}>
        {(['all', 'reports', 'open'] as Filter[]).map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'reports' ? 'Reports' : 'In progress'}
          </button>
        ))}
      </div>

      {q.isPending ? (
        <CardSkeleton lines={6} />
      ) : items.length === 0 ? (
        <Empty icon={Sparkles} title={all.length === 0 ? 'No interviews yet' : 'Nothing here'} action={all.length === 0 ? <Link to="/interview-prep/new" className="btn primary">Start your first interview</Link> : undefined}>
          {all.length === 0 ? 'Your sessions and reports will appear here.' : 'No sessions match this filter.'}
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
                  <span className={`score-pill ${scoreTone(s.overallScore)}`}>{s.overallScore ?? '—'}</span>
                  <ChevronRight className="icon sm chev" aria-hidden />
                </Link>
              );
            })}
          </div>
          {q.hasNextPage && (
            <button className="btn ghost" style={{ marginTop: 12 }} type="button" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? <span className="spinner" /> : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
