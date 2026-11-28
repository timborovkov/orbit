import Link from 'next/link';

import { Inbox } from 'lucide-react';

import { ApprovalSourcePost } from '@/app/approval-source-post';
import { ProposalReviewCard } from '@/app/proposal-review-card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import type { LifecycleState } from '@/lib/lifecycle';
import { INTRODUCTION_REVIEW } from '@/lib/runtime/introductions/types';
import { EMAIL_INTRODUCTION_ACTION } from '@/lib/runtime/outbound/types';
import { X_REPLY_ACTION } from '@/lib/runtime/x/reply-input';
import type { getAgentWorkspace } from '@/lib/server/workspace-queries';

type Workspace = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>;

const actionLabels = {
  reply: 'Reply',
  [X_REPLY_ACTION]: 'X reply',
  like: 'Like',
  repost: 'Repost',
  follow: 'Follow',
  bookmark: 'Bookmark',
  introduce: 'Introduce',
  [INTRODUCTION_REVIEW]: 'Introduction draft',
  [EMAIL_INTRODUCTION_ACTION]: 'Email introduction',
  escalate: 'Escalate',
} as Record<string, string>;

export function ProposalReview({
  agentId,
  reviews,
  lifecycle,
  globalPaused,
}: {
  agentId: string;
  reviews: Workspace['reviews'];
  lifecycle: LifecycleState;
  globalPaused: boolean;
}) {
  return (
    <section className="access-workbench" aria-labelledby="proposal-review-title">
      <div className="editor-section-heading">
        <h2 id="proposal-review-title">Proposal review</h2>
        <p className="muted">
          Pending first. Rules live in{' '}
          <Link href={`/agents/${agentId}?tab=access&access=approvals`}>Access → Approvals</Link>;
          all agents in <Link href="/approvals">Approvals</Link>.
        </p>
      </div>
      {reviews.length === 0 ? (
        <Empty className="border border-border py-10 md:py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No proposals awaiting review</EmptyTitle>
            <EmptyDescription>Actions that need approval appear here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="policy-records" aria-label="Proposals, pending first">
          {reviews.map((proposal) => (
            <li id={`proposal-${proposal.id}`} key={proposal.id}>
              <div className="approvals-row-meta">
                <strong>{actionLabels[proposal.actionType] ?? proposal.actionType}</strong>
                <span className="state-label">
                  {proposal.status === 'pending' ? 'Pending review' : proposal.status}
                </span>
              </div>
              {proposal.introductionId ? (
                <Link href={`/people/introductions/${proposal.introductionId}`}>
                  View disclosure and consent
                </Link>
              ) : (
                proposal.recipients.length > 0 && (
                  <p className="muted">{proposal.recipients.join(' · ')}</p>
                )
              )}
              {proposal.actionType === EMAIL_INTRODUCTION_ACTION && (
                <>
                  <p className="wrap-break-word">To {proposal.recipients.join(', ')}</p>
                  <p className="wrap-break-word">Subject {proposal.subject}</p>
                </>
              )}
              <ApprovalSourcePost post={proposal.sourcePost} />
              {proposal.reason && <p>{proposal.reason}</p>}
              {proposal.status === 'pending' ? (
                <ProposalReviewCard
                  agentId={agentId}
                  proposal={proposal}
                  lifecycle={lifecycle}
                  globalPaused={globalPaused}
                />
              ) : (
                proposal.draft && (
                  <blockquote className="approvals-preview">{proposal.draft}</blockquote>
                )
              )}
              {proposal.reviewedBy && (
                <p className="field-hint">Reviewed by {proposal.reviewedBy}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
