'use client';

import { useId, useState, useTransition } from 'react';

import { useRouter } from 'next/navigation';

import { reviewProposal } from '@/actions/policy';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { approvalBlockReason, clarifyApprovalError } from '@/lib/approvals/block-reason';
import type { LifecycleState } from '@/lib/lifecycle';
import { INTRODUCTION_REVIEW } from '@/lib/runtime/introductions/types';
import { X_REPLY_ACTION, xReplyDraftLength } from '@/lib/runtime/x/reply-input';

export function ProposalReviewCard({
  agentId,
  proposal,
  lifecycle,
  globalPaused,
}: {
  agentId: string;
  proposal: {
    id: string;
    actionType: string;
    draft: string | null;
    status: string | null;
  };
  lifecycle: LifecycleState;
  globalPaused: boolean;
}) {
  const draftId = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [draft, setDraft] = useState(proposal.draft ?? '');
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const blockReason = approvalBlockReason({
    lifecycle,
    globalPaused,
    actionType: proposal.actionType,
  });

  function review(decision: 'approved' | 'rejected') {
    if (decision === 'approved' && blockReason) {
      setError(blockReason);
      toast(blockReason, { variant: 'error' });
      return;
    }
    const form = new FormData();
    form.set('agentId', agentId);
    form.set('intentId', proposal.id);
    form.set('decision', decision);
    if (decision === 'approved' && proposal.actionType !== INTRODUCTION_REVIEW) {
      form.set('draft', draft);
    }
    startTransition(async () => {
      setError(undefined);
      try {
        const result = await reviewProposal(form);
        if ('error' in result) {
          const message = clarifyApprovalError(result.error);
          setError(message);
          toast(message, { variant: 'error' });
          return;
        }
        toast(result.message || (decision === 'approved' ? 'Approved' : 'Rejected'));
        router.refresh();
      } catch {
        const message = 'Review could not be saved. Try again.';
        setError(message);
        toast(message, { variant: 'error' });
      }
    });
  }

  const approveDisabled = pending || Boolean(blockReason);
  const approveButton = (
    <Button
      type="button"
      size="sm"
      disabled={approveDisabled}
      aria-disabled={approveDisabled}
      title={blockReason ?? undefined}
      onClick={() => {
        review('approved');
      }}
    >
      {pending ? 'Working…' : 'Approve'}
    </Button>
  );

  return (
    <div className="proposal-review-card">
      {proposal.actionType === INTRODUCTION_REVIEW ? (
        <blockquote className="approvals-preview">{proposal.draft}</blockquote>
      ) : (
        <Field>
          <FieldLabel htmlFor={draftId}>Draft</FieldLabel>
          <Textarea
            id={draftId}
            rows={3}
            value={draft}
            readOnly={pending}
            maxLength={proposal.actionType === X_REPLY_ACTION ? xReplyDraftLength : 8000}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </Field>
      )}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : blockReason ? (
        <p role="status" className="form-error">
          {blockReason}
        </p>
      ) : null}
      <div className="form-actions">
        {blockReason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="form-actions-disabled-wrap">{approveButton}</span>
            </TooltipTrigger>
            <TooltipContent>{blockReason}</TooltipContent>
          </Tooltip>
        ) : (
          approveButton
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="text-destructive hover:bg-destructive/10"
          disabled={pending}
          onClick={() => {
            review('rejected');
          }}
        >
          {pending ? 'Working…' : 'Reject'}
        </Button>
      </div>
    </div>
  );
}
