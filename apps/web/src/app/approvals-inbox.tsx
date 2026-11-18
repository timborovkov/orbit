'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { reviewProposal, reviewProposalsBulk } from '@/actions/policy';
import { formatAge, formatUtcTimestamp } from '@/lib/format';

const actionLabels = {
  reply: 'Reply',
  like: 'Like',
  repost: 'Repost',
  follow: 'Follow',
  bookmark: 'Bookmark',
  introduce: 'Introduce',
  escalate: 'Escalate',
} as Record<string, string>;

export interface ApprovalItem {
  id: string;
  agentId: string;
  agentName: string;
  actionType: string;
  draft: string | null;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | null;
  createdAt: Date | string;
  reviewedBy: string | null;
  reviewedAt: Date | string | null;
}

export function ApprovalsInbox({
  pending,
  resolved,
}: {
  pending: ApprovalItem[];
  resolved: ApprovalItem[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(() => new Set<string>());
  const [message, setMessage] = useState<string | null>(null);
  const [pendingUi, startTransition] = useTransition();

  const keyFor = (item: ApprovalItem) => `${item.agentId}:${item.id}`;

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const runBulk = (decision: 'approved' | 'rejected') => {
    if (selected.size === 0) {
      setMessage('Select at least one proposal.');
      return;
    }
    const form = new FormData();
    form.set('decision', decision);
    for (const value of selected) form.append('selection', value);
    startTransition(async () => {
      const result = await reviewProposalsBulk(form);
      setMessage('error' in result ? (result.error ?? 'Review failed.') : result.message);
      setSelected(new Set());
      router.refresh();
    });
  };

  const runOne = (item: ApprovalItem, decision: 'approved' | 'rejected', draft?: string) => {
    const form = new FormData();
    form.set('agentId', item.agentId);
    form.set('intentId', item.id);
    form.set('decision', decision);
    if (decision === 'approved' && draft !== undefined) form.set('draft', draft);
    startTransition(async () => {
      const result = await reviewProposal(form);
      setMessage('error' in result ? result.error : result.message);
      router.refresh();
    });
  };

  return (
    <div className="approvals-inbox">
      {message && (
        <p className="field-hint" role="status">
          {message}
        </p>
      )}

      {pending.length > 0 ? (
        <section className="surface" aria-labelledby="pending-approvals-title">
          <div className="section-heading">
            <div className="section-label">
              <h2 id="pending-approvals-title">Pending</h2>
              <span className="count">{pending.length}</span>
            </div>
            <div className="approvals-bulk-actions">
              <button
                type="button"
                className="button-primary"
                disabled={pendingUi || selected.size === 0}
                onClick={() => {
                  runBulk('approved');
                }}
              >
                Bulk approve
              </button>
              <button
                type="button"
                className="button-outline"
                disabled={pendingUi || selected.size === 0}
                onClick={() => {
                  runBulk('rejected');
                }}
              >
                Bulk reject
              </button>
            </div>
          </div>
          <ul className="policy-records approvals-list" aria-label="Pending approvals">
            {pending.map((item) => {
              const key = keyFor(item);
              return (
                <li key={item.id}>
                  <label className="approvals-select">
                    <input
                      type="checkbox"
                      checked={selected.has(key)}
                      onChange={() => {
                        toggle(key);
                      }}
                    />
                    <span className="sr-only">Select {item.actionType}</span>
                  </label>
                  <div className="approvals-row-body">
                    <div className="approvals-row-meta">
                      <strong>{actionLabels[item.actionType] ?? item.actionType}</strong>
                      <span className="state-label">Pending</span>
                      <Link href={`/agents/${item.agentId}`}>{item.agentName}</Link>
                      <span className="muted">{formatAge(item.createdAt)} ago</span>
                      <span className="muted">{formatUtcTimestamp(item.createdAt)}</span>
                    </div>
                    {item.reason && <p>{item.reason}</p>}
                    <label className="field">
                      <span className="field-label">Draft</span>
                      <textarea
                        name={`draft-${item.id}`}
                        rows={2}
                        defaultValue={item.draft ?? ''}
                        maxLength={8000}
                        id={`draft-${item.id}`}
                      />
                    </label>
                    <div className="policy-review-actions">
                      <button
                        type="button"
                        className="button-primary"
                        disabled={pendingUi}
                        onClick={() => {
                          const draft = (
                            document.getElementById(
                              `draft-${item.id}`,
                            ) as HTMLTextAreaElement | null
                          )?.value;
                          runOne(item, 'approved', draft);
                        }}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="button-outline"
                        disabled={pendingUi}
                        onClick={() => {
                          runOne(item, 'rejected');
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <section className="surface">
          <p className="muted">No pending approvals.</p>
        </section>
      )}

      {resolved.length > 0 && (
        <section className="surface" aria-labelledby="approval-history-title">
          <div className="section-heading">
            <div className="section-label">
              <h2 id="approval-history-title">History</h2>
              <span className="count">{resolved.length}</span>
            </div>
          </div>
          <ul className="policy-records approvals-list" aria-label="Resolved approvals">
            {resolved.map((item) => (
              <li key={item.id}>
                <div className="approvals-row-body">
                  <div className="approvals-row-meta">
                    <strong>{actionLabels[item.actionType] ?? item.actionType}</strong>
                    <span className="state-label">{item.status}</span>
                    <Link href={`/agents/${item.agentId}`}>{item.agentName}</Link>
                    <span className="muted">{formatAge(item.createdAt)} ago</span>
                  </div>
                  {item.draft && <blockquote>{item.draft}</blockquote>}
                  {item.reviewedBy && (
                    <p className="field-hint">
                      Reviewed by {item.reviewedBy}
                      {item.reviewedAt ? ` · ${formatUtcTimestamp(item.reviewedAt)}` : ''}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
