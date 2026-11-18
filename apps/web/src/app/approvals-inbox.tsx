'use client';

import { useId, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Inbox } from 'lucide-react';

import { reviewProposal, reviewProposalsBulk } from '@/actions/policy';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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
  status: 'pending' | 'approved' | 'rejected' | 'expired' | null;
  createdAt: Date | string;
  reviewedBy: string | null;
  reviewedAt: Date | string | null;
}

function statusBadge(status: ApprovalItem['status']) {
  if (status === 'approved') {
    return (
      <Badge className="border-transparent bg-emerald-600/15 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300">
        approved
      </Badge>
    );
  }
  if (status === 'rejected') {
    return <Badge variant="destructive">rejected</Badge>;
  }
  if (status === 'expired') {
    return <Badge variant="secondary">expired</Badge>;
  }
  return <Badge variant="outline">Pending</Badge>;
}

function AgeWithTooltip({ value }: { value: Date | string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time className="muted approvals-age" dateTime={new Date(value).toISOString()}>
          {formatAge(value)} ago
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatUtcTimestamp(value)}</TooltipContent>
    </Tooltip>
  );
}

function PendingCard({
  item,
  selected,
  pendingUi,
  onToggle,
  onReview,
}: {
  item: ApprovalItem;
  selected: boolean;
  pendingUi: boolean;
  onToggle: (checked: boolean) => void;
  onReview: (decision: 'approved' | 'rejected', draft?: string) => void;
}) {
  const draftId = useId();
  const selectId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.draft ?? '');
  const label = actionLabels[item.actionType] ?? item.actionType;
  const preview = (item.draft ?? '').trim() || 'No draft text.';

  return (
    <li className="approvals-card">
      <div className="approvals-card-select">
        <Checkbox
          id={selectId}
          checked={selected}
          onCheckedChange={(value) => {
            onToggle(value === true);
          }}
          aria-label={`Select ${label} for ${item.agentName}`}
        />
      </div>
      <div className="approvals-card-body">
        <div className="approvals-card-top">
          <div className="approvals-row-meta">
            <Badge variant="secondary">{label}</Badge>
            {statusBadge('pending')}
            <Link href={`/agents/${item.agentId}`} className="approvals-agent-link">
              {item.agentName}
            </Link>
            <AgeWithTooltip value={item.createdAt} />
          </div>
          <div className="approvals-card-actions">
            <Button
              type="button"
              size="sm"
              disabled={pendingUi}
              onClick={() => {
                onReview('approved', editing ? draft : (item.draft ?? undefined));
              }}
            >
              Approve
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-destructive hover:bg-destructive/10"
              disabled={pendingUi}
              onClick={() => {
                onReview('rejected');
              }}
            >
              Reject
            </Button>
          </div>
        </div>
        {item.reason && <p className="approvals-reason">{item.reason}</p>}
        <div className="approvals-draft-block">
          {editing ? (
            <>
              <label htmlFor={draftId} className="approvals-draft-label">
                Draft
              </label>
              <Textarea
                id={draftId}
                rows={3}
                value={draft}
                maxLength={8000}
                onChange={(event) => {
                  setDraft(event.target.value);
                }}
              />
              <div className="approvals-draft-toolbar">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setDraft(item.draft ?? '');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={pendingUi}
                  onClick={() => {
                    onReview('approved', draft);
                  }}
                >
                  Save & approve
                </Button>
              </div>
            </>
          ) : (
            <>
              <blockquote className="approvals-preview">{preview}</blockquote>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            </>
          )}
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
  const selectAllId = useId();

  const keyFor = (item: ApprovalItem) => `${item.agentId}:${item.id}`;
  const pendingKeys = useMemo(() => pending.map(keyFor), [pending]);
  const allSelected = pendingKeys.length > 0 && pendingKeys.every((key) => selected.has(key));
  const someSelected = pendingKeys.some((key) => selected.has(key));

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
    <TooltipProvider>
      <div className="approvals-inbox">
        {message && (
          <p className="field-hint" role="status">
            {message}
          </p>
        )}

        {pending.length > 0 ? (
          <section className="surface" aria-labelledby="pending-approvals-title">
            <div className="section-heading approvals-pending-heading">
              <div className="section-label">
                <Checkbox
                  id={selectAllId}
                  checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                  onCheckedChange={(value) => {
                    if (value === true) setSelected(new Set(pendingKeys));
                    else setSelected(new Set());
                  }}
                  aria-label="Select all pending approvals"
                />
                <h2 id="pending-approvals-title">Pending</h2>
                <span className="count">{pending.length}</span>
              </div>
            </div>
            <ul className="approvals-card-list" aria-label="Pending approvals">
              {pending.map((item) => {
                const key = keyFor(item);
                return (
                  <PendingCard
                    key={item.id}
                    item={item}
                    selected={selected.has(key)}
                    pendingUi={pendingUi}
                    onToggle={(checked) => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(key);
                        else next.delete(key);
                        return next;
                      });
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
          <Empty className="border border-border py-10 md:py-12" data-testid="approvals-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No pending approvals</EmptyTitle>
              <EmptyDescription>
                When an agent action needs review, it appears here until you approve or reject it.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {resolved.length > 0 && (
          <section className="surface" aria-labelledby="approval-history-title">
            <div className="section-heading">
              <div className="section-label">
                <h2 id="approval-history-title">History</h2>
                <span className="count">{resolved.length}</span>
              </div>
            </div>
            <ul className="approvals-card-list" aria-label="Resolved approvals">
              {resolved.map((item) => (
                <li key={item.id} className="approvals-card approvals-history-card">
                  <div className="approvals-card-body">
                    <div className="approvals-card-top">
                      <div className="approvals-row-meta">
                        <Badge variant="secondary">
                          {actionLabels[item.actionType] ?? item.actionType}
                        </Badge>
                        {statusBadge(item.status)}
                        <Link href={`/agents/${item.agentId}`} className="approvals-agent-link">
                          {item.agentName}
                        </Link>
                        <AgeWithTooltip value={item.createdAt} />
                      </div>
                    </div>
                    {item.draft && (
                      <blockquote className="approvals-preview">{item.draft}</blockquote>
                    )}
                    {item.reviewedBy && (
                      <p className="field-hint approvals-reviewed-by">
                        Reviewed by {item.reviewedBy}
                        {item.reviewedAt ? (
                          <>
                            {' · '}
                            <AgeWithTooltip value={item.reviewedAt} />
                          </>
                        ) : null}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {someSelected && (
          <div className="approvals-bulk-bar" role="region" aria-label="Bulk approval actions">
            <span className="approvals-bulk-count">{selected.size} selected</span>
            <div className="approvals-bulk-actions">
              <Button
                type="button"
                size="sm"
                disabled={pendingUi}
                onClick={() => {
                  runBulk('approved');
                }}
              >
                Bulk approve
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-destructive hover:bg-destructive/10"
                disabled={pendingUi}
                onClick={() => {
                  runBulk('rejected');
                }}
              >
                Bulk reject
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pendingUi}
                onClick={() => {
                  setSelected(new Set());
                }}
              >
                Clear
              </Button>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
