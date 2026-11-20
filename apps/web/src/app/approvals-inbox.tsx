'use client';

import { useId, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Inbox, Pencil } from 'lucide-react';

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
import { Field, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { approvalReviewLimit } from '@/lib/approvals/rules';
import { formatAge, formatUtcTimestamp } from '@/lib/format';
import { cn } from '@/lib/utils';

const actionLabels = {
  reply: 'Reply',
  like: 'Like',
  repost: 'Repost',
  follow: 'Follow',
  bookmark: 'Bookmark',
  introduce: 'Introduce',
  escalate: 'Escalate',
  'email.send': 'Email reply',
} as Record<string, string>;

export interface ApprovalItem {
  id: string;
  agentId: string;
  agentName: string;
  actionType: string;
  runId: string | null;
  recipients: string[];
  draft: string | null;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | null;
  createdAt: Date | string;
  reviewedBy: string | null;
  reviewedAt: Date | string | null;
  reviewNote: string | null;
}

function statusBadge(status: ApprovalItem['status']) {
  if (status === 'approved') {
    return (
      <Badge className="border-transparent bg-emerald-600/15 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300">
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

function AgeWithTooltip({ value, renderedAt }: { value: Date | string; renderedAt: string }) {
  const label = `${formatAge(value, new Date(renderedAt))} ago`;
  const full = formatUtcTimestamp(value);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time className="muted approvals-age" dateTime={new Date(value).toISOString()} title={full}>
          {label}
        </time>
      </TooltipTrigger>
      <TooltipContent>{full}</TooltipContent>
    </Tooltip>
  );
}

function ProposalContext({ item }: { item: ApprovalItem }) {
  if (!item.recipients.length && !item.runId) return null;
  return (
    <div className="approvals-proposal-context">
      {item.recipients.length > 0 && <span>Recipients {item.recipients.join(' · ')}</span>}
      {item.runId && (
        <Link href={`/agents/${item.agentId}?run=${item.runId}#run-${item.runId}`}>
          View originating run
        </Link>
      )}
    </div>
  );
}

function PendingCard({
  item,
  selected,
  disableSelection,
  renderedAt,
  pendingUi,
  onToggle,
  onEditingChange,
  onReview,
}: {
  item: ApprovalItem;
  selected: boolean;
  disableSelection: boolean;
  renderedAt: string;
  pendingUi: boolean;
  onToggle: (checked: boolean) => void;
  onEditingChange: (editing: boolean) => void;
  onReview: (decision: 'approved' | 'rejected', draft?: string) => void;
}) {
  const draftId = useId();
  const selectId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.draft ?? '');
  const label = actionLabels[item.actionType] ?? item.actionType;
  const preview = (item.draft ?? '').trim() || 'No draft text.';

  const setEditingState = (next: boolean) => {
    setEditing(next);
    onEditingChange(next);
  };

  return (
    <li className="approvals-card">
      <div className="approvals-card-select">
        <Checkbox
          id={selectId}
          checked={selected}
          disabled={disableSelection}
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
            <AgeWithTooltip value={item.createdAt} renderedAt={renderedAt} />
          </div>
          <div className="approvals-card-actions">
            {!editing && (
              <Button
                type="button"
                size="sm"
                disabled={pendingUi}
                onClick={() => {
                  onReview('approved');
                }}
              >
                Approve
              </Button>
            )}
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
        <ProposalContext item={item} />
        {item.reason && <p className="approvals-reason">{item.reason}</p>}
        <div className="approvals-draft-block">
          {editing ? (
            <>
              <Field>
                <FieldLabel htmlFor={draftId}>Draft</FieldLabel>
                <Textarea
                  id={draftId}
                  rows={3}
                  readOnly={pendingUi}
                  value={draft}
                  maxLength={8000}
                  onChange={(event) => {
                    setDraft(event.target.value);
                  }}
                />
              </Field>
              <div className="approvals-draft-toolbar">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingState(false);
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
                className="approvals-edit-button"
                onClick={() => {
                  setEditingState(true);
                }}
              >
                <Pencil aria-hidden="true" />
                Edit
              </Button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function HistoryCard({ item, renderedAt }: { item: ApprovalItem; renderedAt: string }) {
  return (
    <li className="approvals-card approvals-history-card">
      <div className="approvals-card-body">
        <div className="approvals-history-primary">
          <Badge variant="secondary">{actionLabels[item.actionType] ?? item.actionType}</Badge>
          {statusBadge(item.reviewNote === 'expired' ? 'expired' : item.status)}
          <Link href={`/agents/${item.agentId}`} className="approvals-agent-link">
            {item.agentName}
          </Link>
        </div>
        <div className="approvals-history-secondary">
          <AgeWithTooltip value={item.createdAt} renderedAt={renderedAt} />
          {item.reviewedBy ? (
            <span className="approvals-reviewed-by">
              Reviewed by {item.reviewedBy}
              {item.reviewedAt ? (
                <>
                  {' · '}
                  <AgeWithTooltip value={item.reviewedAt} renderedAt={renderedAt} />
                </>
              ) : null}
            </span>
          ) : null}
        </div>
        <ProposalContext item={item} />
        {item.draft ? <blockquote className="approvals-preview">{item.draft}</blockquote> : null}
      </div>
    </li>
  );
}

function BulkActionBar({
  selectedCount,
  pendingUi,
  blockedByEdits,
  onApprove,
  onReject,
  onClear,
}: {
  selectedCount: number;
  pendingUi: boolean;
  blockedByEdits: boolean;
  onApprove: () => void;
  onReject: () => void;
  onClear: () => void;
}) {
  const editHint = 'Finish or cancel draft edits before bulk review';
  return (
    <div className="approvals-bulk-bar" role="region" aria-label="Bulk approval actions">
      <span className="approvals-bulk-count">{selectedCount} selected</span>
      <div className="approvals-bulk-actions">
        <Button
          type="button"
          size="sm"
          disabled={pendingUi || blockedByEdits}
          title={blockedByEdits ? editHint : undefined}
          onClick={onApprove}
        >
          Bulk approve
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="text-destructive hover:bg-destructive/10"
          disabled={pendingUi || blockedByEdits}
          title={blockedByEdits ? editHint : undefined}
          onClick={onReject}
        >
          Bulk reject
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pendingUi} onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}

export function ApprovalsInbox({
  pending,
  resolved,
  renderedAt,
}: {
  pending: ApprovalItem[];
  resolved: ApprovalItem[];
  renderedAt: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(() => new Set<string>());
  const [editingKeys, setEditingKeys] = useState(() => new Set<string>());
  const [message, setMessage] = useState<string | null>(null);
  const [pendingUi, startTransition] = useTransition();
  const selectAllId = useId();

  const keyFor = (item: ApprovalItem) => `${item.agentId}:${item.id}`;
  const pendingKeys = useMemo(() => pending.map(keyFor), [pending]);
  const pendingKeySet = useMemo(() => new Set(pendingKeys), [pendingKeys]);
  // Derive against the current filter so stale keys from a previous agent filter are ignored.
  const visibleSelected = useMemo(
    () => new Set([...selected].filter((key) => pendingKeySet.has(key))),
    [selected, pendingKeySet],
  );
  const visibleEditing = useMemo(
    () => new Set([...editingKeys].filter((key) => pendingKeySet.has(key))),
    [editingKeys, pendingKeySet],
  );

  const selectionLimit = Math.min(approvalReviewLimit, pendingKeys.length);
  const allSelected = selectionLimit > 0 && visibleSelected.size === selectionLimit;
  const selectionLabel =
    pendingKeys.length > approvalReviewLimit
      ? `Select up to ${approvalReviewLimit} pending approvals`
      : 'Select all pending approvals';
  const someSelected = pendingKeys.some((key) => visibleSelected.has(key));
  const selectedHasUnsavedEdits = [...visibleSelected].some((key) => visibleEditing.has(key));

  const runBulk = (decision: 'approved' | 'rejected') => {
    if (visibleSelected.size === 0) {
      setMessage('Select at least one proposal.');
      return;
    }
    if ([...visibleSelected].some((key) => visibleEditing.has(key))) {
      setMessage('Finish or cancel draft edits before bulk approve.');
      return;
    }
    const form = new FormData();
    form.set('decision', decision);
    for (const value of visibleSelected) form.append('selection', value);
    startTransition(async () => {
      try {
        const result = await reviewProposalsBulk(form);
        setMessage('error' in result ? (result.error ?? 'Review failed.') : result.message);
        setSelected(new Set());
        router.refresh();
      } catch {
        setMessage('Review could not be saved. Try again.');
      }
    });
  };

  const runOne = (item: ApprovalItem, decision: 'approved' | 'rejected', draft?: string) => {
    const form = new FormData();
    form.set('agentId', item.agentId);
    form.set('intentId', item.id);
    form.set('decision', decision);
    if (decision === 'approved' && draft !== undefined) form.set('draft', draft);
    startTransition(async () => {
      try {
        const result = await reviewProposal(form);
        setMessage('error' in result ? result.error : result.message);
        router.refresh();
      } catch {
        setMessage('Review could not be saved. Try again.');
      }
    });
  };

  return (
    <TooltipProvider>
      <div className={cn('approvals-inbox', someSelected && 'approvals-inbox-has-bulk')}>
        {message ? (
          <p className="field-hint" role="status">
            {message}
          </p>
        ) : null}

        {pending.length > 0 ? (
          <section className="surface" aria-labelledby="pending-approvals-title">
            <div className="section-heading approvals-pending-heading">
              <div className="section-label">
                <Checkbox
                  id={selectAllId}
                  checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                  onCheckedChange={(value) => {
                    if (value === true) setSelected(new Set(pendingKeys.slice(0, selectionLimit)));
                    else setSelected(new Set());
                  }}
                  disabled={pendingUi}
                  aria-label={selectionLabel}
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
                    selected={visibleSelected.has(key)}
                    disableSelection={pendingUi || (allSelected && !visibleSelected.has(key))}
                    renderedAt={renderedAt}
                    pendingUi={pendingUi}
                    onToggle={(checked) => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (!checked) next.delete(key);
                        else if (next.size < selectionLimit) next.add(key);
                        return next;
                      });
                    }}
                    onEditingChange={(editing) => {
                      setEditingKeys((current) => {
                        const next = new Set(current);
                        if (editing) next.add(key);
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
            {someSelected ? <div className="approvals-bulk-spacer" aria-hidden="true" /> : null}
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

        {resolved.length > 0 ? (
          <section className="surface" aria-labelledby="approval-history-title">
            <div className="section-heading">
              <div className="section-label">
                <h2 id="approval-history-title">History</h2>
                <span className="count">{resolved.length}</span>
              </div>
            </div>
            <ul className="approvals-card-list" aria-label="Resolved approvals">
              {resolved.map((item) => (
                <HistoryCard key={item.id} item={item} renderedAt={renderedAt} />
              ))}
            </ul>
          </section>
        ) : null}

        {someSelected ? (
          <BulkActionBar
            selectedCount={visibleSelected.size}
            pendingUi={pendingUi}
            blockedByEdits={selectedHasUnsavedEdits}
            onApprove={() => {
              runBulk('approved');
            }}
            onReject={() => {
              runBulk('rejected');
            }}
            onClear={() => {
              setSelected(new Set());
            }}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}
