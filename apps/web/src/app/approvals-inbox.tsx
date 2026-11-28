'use client';

import { useId, useMemo, useState, useTransition } from 'react';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { Inbox, Pencil } from 'lucide-react';

import { reviewProposal, reviewProposalsBulk } from '@/actions/policy';
import { type ApprovalPost, ApprovalSourcePost } from '@/app/approval-source-post';
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
import { useToast } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { approvalBlockReason, clarifyApprovalError } from '@/lib/approvals/block-reason';
import { approvalReviewLimit } from '@/lib/approvals/rules';
import { formatAge, formatUtcTimestamp } from '@/lib/format';
import { INTRODUCTION_REVIEW } from '@/lib/runtime/introductions/types';
import { EMAIL_INTRODUCTION_ACTION } from '@/lib/runtime/outbound/types';
import { X_REPLY_ACTION, xReplyDraftLength } from '@/lib/runtime/x/reply-input';
import { cn } from '@/lib/utils';

const actionLabels = {
  reply: 'Reply',
  [X_REPLY_ACTION]: 'X reply',
  like: 'Like',
  repost: 'Repost',
  follow: 'Follow',
  bookmark: 'Bookmark',
  introduce: 'Introduce',
  escalate: 'Escalate',
  'email.send': 'Email reply',
  [INTRODUCTION_REVIEW]: 'Introduction draft',
  [EMAIL_INTRODUCTION_ACTION]: 'Email introduction',
} as Record<string, string>;

export interface ApprovalItem {
  id: string;
  agentId: string;
  agentName: string;
  agentLifecycle?: string;
  actionType: string;
  runId: string | null;
  introductionId: string | null;
  recipients: string[];
  sourcePost: ApprovalPost | null;
  draft: string | null;
  subject?: string | null;
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
  if (!item.recipients.length && !item.runId && !item.introductionId) return null;
  return (
    <div className="approvals-proposal-context">
      {item.introductionId ? (
        <Link href={`/people/introductions/${item.introductionId}`}>
          View disclosure and consent
        </Link>
      ) : (
        item.recipients.length > 0 && <span>Recipients {item.recipients.join(' · ')}</span>
      )}
      {item.actionType === EMAIL_INTRODUCTION_ACTION && (
        <>
          <span className="wrap-break-word">To {item.recipients.join(', ')}</span>
          <span className="wrap-break-word">Subject {item.subject}</span>
        </>
      )}
      {item.runId && (
        <Link href={`/agents/${item.agentId}?run=${item.runId}#run-${item.runId}`}>
          View originating run
        </Link>
      )}
    </div>
  );
}

function PendingDraftBlock({
  item,
  draftId,
  editing,
  draft,
  pendingUi,
  approveBlockedReason,
  onCancel,
  onChangeDraft,
  onSaveApprove,
  onStartEdit,
}: {
  item: ApprovalItem;
  draftId: string;
  editing: boolean;
  draft: string;
  pendingUi: boolean;
  approveBlockedReason: string | null;
  onCancel: () => void;
  onChangeDraft: (value: string) => void;
  onSaveApprove: () => void;
  onStartEdit: () => void;
}) {
  if (editing) {
    return (
      <div className="approvals-draft-block">
        <Field>
          <FieldLabel htmlFor={draftId}>Draft</FieldLabel>
          <Textarea
            id={draftId}
            rows={3}
            readOnly={pendingUi}
            value={draft}
            maxLength={item.actionType === X_REPLY_ACTION ? xReplyDraftLength : 8000}
            onChange={(event) => {
              onChangeDraft(event.target.value);
            }}
          />
        </Field>
        <div className="approvals-draft-toolbar">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pendingUi || Boolean(approveBlockedReason)}
            title={approveBlockedReason ?? undefined}
            onClick={onSaveApprove}
          >
            {pendingUi ? 'Working…' : 'Save & approve'}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="approvals-draft-block">
      <blockquote className="approvals-preview">
        {(item.draft ?? '').trim() || 'No draft text.'}
      </blockquote>
      {item.actionType !== INTRODUCTION_REVIEW && item.actionType !== EMAIL_INTRODUCTION_ACTION && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="approvals-edit-button"
          onClick={onStartEdit}
        >
          <Pencil aria-hidden="true" />
          Edit
        </Button>
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
  approveBlockedReason,
  onToggle,
  onEditingChange,
  onReview,
}: {
  item: ApprovalItem;
  selected: boolean;
  disableSelection: boolean;
  renderedAt: string;
  pendingUi: boolean;
  approveBlockedReason: string | null;
  onToggle: (checked: boolean) => void;
  onEditingChange: (editing: boolean) => void;
  onReview: (decision: 'approved' | 'rejected', draft?: string) => void;
}) {
  const draftId = useId();
  const selectId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.draft ?? '');
  const label = actionLabels[item.actionType] ?? item.actionType;
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
                disabled={pendingUi || Boolean(approveBlockedReason)}
                title={approveBlockedReason ?? undefined}
                onClick={() => {
                  onReview('approved');
                }}
              >
                {pendingUi ? 'Working…' : 'Approve'}
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
              {pendingUi ? 'Working…' : 'Reject'}
            </Button>
          </div>
        </div>
        <ProposalContext item={item} />
        <ApprovalSourcePost post={item.sourcePost} />
        {approveBlockedReason ? (
          <p role="status" className="form-error">
            {approveBlockedReason}
          </p>
        ) : null}
        {item.reason && <p className="approvals-reason">{item.reason}</p>}
        <PendingDraftBlock
          item={item}
          draftId={draftId}
          editing={editing}
          draft={draft}
          pendingUi={pendingUi}
          approveBlockedReason={approveBlockedReason}
          onCancel={() => {
            setEditingState(false);
            setDraft(item.draft ?? '');
          }}
          onChangeDraft={setDraft}
          onSaveApprove={() => {
            onReview('approved', draft);
          }}
          onStartEdit={() => {
            setEditingState(true);
          }}
        />
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
        <ApprovalSourcePost post={item.sourcePost} />
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

function applyReviewFeedback(
  result: { error?: string; message?: string },
  setMessage: (value: string) => void,
  setMessageTone: (value: 'status' | 'error') => void,
  toast: (message: string, options?: { variant?: 'success' | 'error' }) => number,
  fallbackSuccess: string,
) {
  if (result.error) {
    const msg = clarifyApprovalError(result.error);
    setMessage(msg);
    setMessageTone('error');
    toast(msg, { variant: 'error' });
    return;
  }
  const msg = result.message || fallbackSuccess;
  setMessage(msg);
  setMessageTone(msg.includes('failed') ? 'error' : 'status');
  toast(msg, { variant: msg.includes('failed') ? 'error' : 'success' });
}

function PendingList({
  pending,
  selectAllId,
  selectionLabel,
  allSelected,
  someSelected,
  pendingUi,
  renderedAt,
  visibleSelected,
  blockFor,
  keyFor,
  onSelectAll,
  onToggle,
  onEditingChange,
  onReview,
}: {
  pending: ApprovalItem[];
  selectAllId: string;
  selectionLabel: string;
  allSelected: boolean;
  someSelected: boolean;
  pendingUi: boolean;
  renderedAt: string;
  visibleSelected: Set<string>;
  blockFor: (item: ApprovalItem) => string | null;
  keyFor: (item: ApprovalItem) => string;
  onSelectAll: (checked: boolean) => void;
  onToggle: (key: string, checked: boolean) => void;
  onEditingChange: (key: string, editing: boolean) => void;
  onReview: (item: ApprovalItem, decision: 'approved' | 'rejected', draft?: string) => void;
}) {
  return (
    <section className="surface" aria-labelledby="pending-approvals-title">
      <div className="section-heading approvals-pending-heading">
        <div className="section-label">
          <Checkbox
            id={selectAllId}
            checked={allSelected ? true : someSelected ? 'indeterminate' : false}
            onCheckedChange={(value) => {
              onSelectAll(value === true);
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
              approveBlockedReason={blockFor(item)}
              onToggle={(checked) => {
                onToggle(key, checked);
              }}
              onEditingChange={(editing) => {
                onEditingChange(key, editing);
              }}
              onReview={(decision, draft) => {
                onReview(item, decision, draft);
              }}
            />
          );
        })}
      </ul>
      {someSelected ? <div className="approvals-bulk-spacer" aria-hidden="true" /> : null}
    </section>
  );
}

function ResolvedList({ resolved, renderedAt }: { resolved: ApprovalItem[]; renderedAt: string }) {
  return (
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
  );
}

export function ApprovalsInbox({
  pending,
  resolved,
  renderedAt,
  globalPaused,
  agentStates,
}: {
  pending: ApprovalItem[];
  resolved: ApprovalItem[];
  renderedAt: string;
  globalPaused: boolean;
  agentStates: Record<string, string>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [selected, setSelected] = useState(() => new Set<string>());
  const [editingKeys, setEditingKeys] = useState(() => new Set<string>());
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<'status' | 'error'>('status');
  const [pendingUi, startTransition] = useTransition();
  const blockFor = (item: ApprovalItem) =>
    approvalBlockReason({
      lifecycle: item.agentLifecycle ?? agentStates[item.agentId] ?? 'shadow',
      globalPaused,
      actionType: item.actionType,
    });
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
        applyReviewFeedback(result, setMessage, setMessageTone, toast, 'Review saved.');
        setSelected(new Set());
        router.refresh();
      } catch {
        const msg = 'Review could not be saved. Try again.';
        setMessage(msg);
        setMessageTone('error');
        toast(msg, { variant: 'error' });
      }
    });
  };

  const runOne = (item: ApprovalItem, decision: 'approved' | 'rejected', draft?: string) => {
    if (decision === 'approved') {
      const blocked = blockFor(item);
      if (blocked) {
        setMessage(blocked);
        setMessageTone('error');
        toast(blocked, { variant: 'error' });
        return;
      }
    }
    const form = new FormData();
    form.set('agentId', item.agentId);
    form.set('intentId', item.id);
    form.set('decision', decision);
    if (decision === 'approved' && draft !== undefined) form.set('draft', draft);
    startTransition(async () => {
      try {
        const result = await reviewProposal(form);
        applyReviewFeedback(
          result,
          setMessage,
          setMessageTone,
          toast,
          decision === 'approved' ? 'Approved' : 'Rejected',
        );
        router.refresh();
      } catch {
        const msg = 'Review could not be saved. Try again.';
        setMessage(msg);
        setMessageTone('error');
        toast(msg, { variant: 'error' });
      }
    });
  };

  return (
    <TooltipProvider>
      <div className={cn('approvals-inbox', someSelected && 'approvals-inbox-has-bulk')}>
        {message ? (
          <p
            className={messageTone === 'error' ? 'form-error' : 'field-hint'}
            role={messageTone === 'error' ? 'alert' : 'status'}
          >
            {message}
          </p>
        ) : null}

        {pending.length > 0 ? (
          <PendingList
            pending={pending}
            selectAllId={selectAllId}
            selectionLabel={selectionLabel}
            allSelected={allSelected}
            someSelected={someSelected}
            pendingUi={pendingUi}
            renderedAt={renderedAt}
            visibleSelected={visibleSelected}
            blockFor={blockFor}
            keyFor={keyFor}
            onSelectAll={(checked) => {
              setSelected(checked ? new Set(pendingKeys.slice(0, selectionLimit)) : new Set());
            }}
            onToggle={(key, checked) => {
              setSelected((current) => {
                const next = new Set(current);
                if (!checked) next.delete(key);
                else if (next.size < selectionLimit) next.add(key);
                return next;
              });
            }}
            onEditingChange={(key, editing) => {
              setEditingKeys((current) => {
                const next = new Set(current);
                if (editing) next.add(key);
                else next.delete(key);
                return next;
              });
            }}
            onReview={runOne}
          />
        ) : (
          <Empty className="border border-border py-10 md:py-12" data-testid="approvals-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No pending approvals</EmptyTitle>
              <EmptyDescription>Nothing waiting for review.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {resolved.length > 0 ? <ResolvedList resolved={resolved} renderedAt={renderedAt} /> : null}

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
