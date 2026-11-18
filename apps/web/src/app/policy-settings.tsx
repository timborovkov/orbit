import { Inbox } from 'lucide-react';

import {
  reviewProposal,
  saveApprovalTools,
  saveConsent,
  saveConsentRequirements,
} from '@/actions/policy';
import { ActionRequirementsForm } from '@/app/action-requirements-form';
import { WorkspaceField, WorkspaceSelect } from '@/app/workspace-field';
import { WorkspaceForm } from '@/app/workspace-form';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { FieldGroup } from '@/components/ui/field';
import { proposalTypes, type ConsentScope } from '@/lib/policy/scopes';
import type { getAgentWorkspace } from '@/lib/server/workspace-queries';

type Workspace = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>;

const actionLabels = {
  reply: 'Reply',
  like: 'Like',
  repost: 'Repost',
  follow: 'Follow',
  bookmark: 'Bookmark',
  introduce: 'Introduce',
  escalate: 'Escalate',
} as Record<string, string>;

const approvalOptions = proposalTypes.map((value) => ({ value, label: actionLabels[value] }));
const consentOptions = [
  { value: 'introduce', label: 'Introductions' },
  { value: 'escalate', label: 'Escalations' },
];

export function ReviewSettings({
  agentId,
  approvalTools,
}: {
  agentId: string;
  approvalTools: string[];
}) {
  return (
    <section className="access-workbench">
      <div className="editor-section-heading">
        <h2>Approval requirements</h2>
      </div>
      <ActionRequirementsForm
        agentId={agentId}
        idPrefix="approval-tool"
        options={approvalOptions}
        selected={approvalTools}
        action={saveApprovalTools}
        label="Save approval requirements"
        legend="Require administrator review"
        description="Choose which proposals from this agent wait for an administrator decision."
      />
    </section>
  );
}

export function ConsentSettings({
  agentId,
  consents,
  consentRequiredTools,
}: {
  agentId: string;
  consents: Workspace['consents'];
  consentRequiredTools: ConsentScope[];
}) {
  return (
    <section className="access-workbench">
      <div className="editor-section-heading">
        <h2>Recipient consent</h2>
        <p className="muted">
          Record a recipient’s choice and the source of their consent for this agent.
        </p>
      </div>
      <ActionRequirementsForm
        agentId={agentId}
        idPrefix="consent-tool"
        options={consentOptions}
        selected={consentRequiredTools}
        action={saveConsentRequirements}
        label="Save consent requirements"
        legend="Require recipient consent"
        description="Choose which actions require recorded permission from everyone involved. Recorded refusals and revocations always block the action."
      />
      <div className="consent-records-block">
        <h3 className="consent-records-title">Existing consents</h3>
        {consents.length > 0 ? (
          <ul className="policy-records" aria-label="Recent consent records">
            {consents.map((record) => (
              <li key={JSON.stringify([record.recipient, record.scope])}>
                <strong>{record.recipient}</strong> · {actionLabels[record.scope]} ·{' '}
                {record.granted ? 'Granted' : 'Revoked'}
                <p className="field-hint">{record.evidence}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted consent-records-empty">No consent records yet.</p>
        )}
      </div>
      <WorkspaceForm action={saveConsent} label="Save consent">
        <input type="hidden" name="agentId" value={agentId} />
        <FieldGroup className="gap-5">
          <WorkspaceField
            id="consent-recipient"
            name="recipient"
            label="Recipient ID"
            maxLength={120}
            required
            description="Use the same recipient ID the playground consent checks will receive."
          />
          <WorkspaceSelect
            id="consent-scope"
            name="scope"
            label="Consent scope"
            initialValue="introduce"
            options={consentOptions}
          />
          <WorkspaceSelect
            id="consent-outcome"
            name="outcome"
            label="Recipient decision"
            initialValue="grant"
            options={[
              { value: 'grant', label: 'Grant' },
              { value: 'revoke', label: 'Revoke' },
            ]}
          />
          <WorkspaceField
            id="consent-evidence"
            name="evidence"
            label="Evidence reference"
            maxLength={1000}
            required
            description="Link or note that shows where this choice was recorded."
          />
        </FieldGroup>
      </WorkspaceForm>
    </section>
  );
}

export function ProposalReview({
  agentId,
  reviews,
}: {
  agentId: string;
  reviews: Workspace['reviews'];
}) {
  return (
    <section className="access-workbench" aria-labelledby="proposal-review-title">
      <div className="editor-section-heading">
        <h2 id="proposal-review-title">Proposal review</h2>
        <p className="muted">
          Review simulated actions. Approval records your decision without sending the action.
        </p>
      </div>
      {reviews.length === 0 ? (
        <Empty className="border border-border py-10 md:py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No proposals awaiting review</EmptyTitle>
            <EmptyDescription>
              Simulated actions that require administrator approval appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="policy-records" aria-label="Proposals, pending first">
          {reviews.map((proposal) => (
            <li id={`proposal-${proposal.id}`} key={proposal.id}>
              <strong>{actionLabels[proposal.actionType] ?? proposal.actionType}</strong>{' '}
              <span className="state-label">
                {proposal.status === 'pending' ? 'Pending review' : proposal.status}
              </span>
              {proposal.recipients.length > 0 && (
                <p className="muted">{proposal.recipients.join(' · ')}</p>
              )}
              {proposal.reason && <p>{proposal.reason}</p>}
              {proposal.draft && <blockquote>{proposal.draft}</blockquote>}
              {proposal.status === 'pending' && (
                <div className="policy-review-actions">
                  {(['approved', 'rejected'] as const).map((decision) => (
                    <WorkspaceForm
                      key={decision}
                      action={reviewProposal}
                      label={decision === 'approved' ? 'Approve' : 'Reject'}
                    >
                      <input type="hidden" name="agentId" value={agentId} />
                      <input type="hidden" name="intentId" value={proposal.id} />
                      <input type="hidden" name="decision" value={decision} />
                    </WorkspaceForm>
                  ))}
                </div>
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
