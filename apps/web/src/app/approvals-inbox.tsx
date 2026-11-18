'use client';

import { useId, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { reviewProposal, reviewProposalsBulk } from '@/actions/policy';
import { Button } from '@/components/ui/button';
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

function PendingRow({
  item,
  selected,
  pendingUi,
  onToggle,
  onReview,
}: {
  item: ApprovalItem;
  selected: boolean;
  pendingUi: boolean;
  onToggle: () => void;
  onReview: (decision: 'approved' | 'rejected', draft?: string) => void;
}) {
  const draftId = useId();
  const selectId = useId();
  const keyLabel = actionLabels[item.actionType] ?? item.actionType;

  return (
    <li className="approvals-row">
      <div className="approvals-row-select">
        <input
          id={selectId}
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${keyLabel} for ${item.agentName}`}
        />
      </div>
      <div className="approvals-row-body">
        <div className="approvals-row-meta">
          <strong>{keyLabel}</strong>
          <span className="state-label">Pending</span>
          <Link href={`/agents/${item.agentId}`}>{item.agentName}</Link>
          <span className="muted mono">{formatAge(item.createdAt)} ago</span>
          <span className="muted mono">{formatUtcTimestamp(item.createdAt)}</span>
        </div>
        {item.reason && <p className="approvals-reason">{item.reason}</p>}
        <div className="approvals-draft">
          <label htmlFor={draftId}>Draft</label>
          <textarea
            id={draftId}
            name={`draft-${item.id}`}
            rows={3}
            defaultValue={item.draft ?? ''}
            maxLength={8000}
          />
        </div>
        <div className="approvals-row-actions">
          <Button
            type="button"
            disabled={pendingUi}
            onClick={() => {
              const draft = (document.getElementById(draftId) as HTMLTextAreaElement | null)?.value;
              onReview('approved', draft);
            }}
          >
            Approve
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pendingUi}
            onClick={() => {
              onReview('rejected');
            }}
          >
            Reject
          </Button>
        </div>
      </div>
    </li>
  );
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
              <Button
                type="button"
                disabled={pendingUi || selected.size === 0}
                onClick={() => {
                  runBulk('approved');
                }}
              >
                Bulk approve
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pendingUi || selected.size === 0}
                onClick={() => {
                  runBulk('rejected');
                }}
              >
                Bulk reject
              </Button>
            </div>
          </div>
          <ul className="approvals-list" aria-label="Pending approvals">
            {pending.map((item) => {
              const key = keyFor(item);
              return (
                <PendingRow
                  key={item.id}
                  item={item}
                  selected={selected.has(key)}
                  pendingUi={pendingUi}
                  onToggle={() => {
                    toggle(key);
                  }}
                  onReview={(decision, draft) => {
                    runOne(item, decision, draft);
                  }}
                />
              );
            })}
          </ul>
        </section>
      ) : (
        <section className="surface">
          <div className="empty-state">
            <h3>No pending approvals</h3>
            <p>
              When an agent action needs review, it appears here until you approve or reject it.
            </p>
          </div>
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
          <ul className="approvals-list approvals-history" aria-label="Resolved approvals">
            {resolved.map((item) => (
              <li key={item.id} className="approvals-row">
                <div className="approvals-row-body">
                  <div className="approvals-row-meta">
                    <strong>{actionLabels[item.actionType] ?? item.actionType}</strong>
                    <span className="state-label">{item.status}</span>
                    <Link href={`/agents/${item.agentId}`}>{item.agentName}</Link>
                    <span className="muted mono">{formatAge(item.createdAt)} ago</span>
                  </div>
                  {item.draft && (
                    <blockquote className="approvals-preview">{item.draft}</blockquote>
                  )}
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
