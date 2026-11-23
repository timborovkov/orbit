import Link from 'next/link';

import { Inbox } from 'lucide-react';

import { savePeopleGrant } from '@/actions/introductions';
import {
  reviewProposal,
  saveChannelGrant,
  saveConsent,
  saveConsentRequirements,
} from '@/actions/policy';
import { ActionRequirementsForm } from '@/app/action-requirements-form';
import { ApprovalToolsForm } from '@/app/approval-tools-form';
import { WorkspaceField, WorkspaceSelect } from '@/app/workspace-field';
import { WorkspaceForm } from '@/app/workspace-form';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import type { ConsentScope } from '@/lib/policy/scopes';
import { INTRODUCTION_REVIEW, peopleGrants } from '@/lib/runtime/introductions/types';
import type { getAgentWorkspace } from '@/lib/server/workspace-queries';

type Workspace = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>;

const actionLabels = {
  reply: 'Reply',
  like: 'Like',
  repost: 'Repost',
  follow: 'Follow',
  bookmark: 'Bookmark',
  introduce: 'Introduce',
  [INTRODUCTION_REVIEW]: 'Introduction draft',
  escalate: 'Escalate',
} as Record<string, string>;

const consentOptions = [
  { value: 'introduce', label: 'Introductions' },
  { value: 'escalate', label: 'Escalations' },
];

export function ReviewSettings({
  agentId,
  configurationVersion,
  approvalTools,
  approvalExpiresAfterHours,
  approvalOnReject,
  approvalSpendCents,
  channelActions,
}: {
  agentId: string;
  configurationVersion: number;
  approvalTools: string[];
  approvalExpiresAfterHours: number | null;
  approvalOnReject: 'continue' | 'end';
  approvalSpendCents: number | null;
  channelActions: {
    type: string;
    label: string;
    enabled: boolean;
    alwaysRequiresApproval: boolean;
  }[];
}) {
  return (
    <section className="access-workbench" data-testid="approval-settings">
      <div className="editor-section-heading">
        <h2>Approval requirements</h2>
        <p className="muted">
          Off by default. Enable actions that must pause for an administrator before continuing.
          People introductions enter review after both participants agree.
        </p>
      </div>
      <ApprovalToolsForm
        agentId={agentId}
        configurationVersion={configurationVersion}
        approvalTools={approvalTools}
        approvalExpiresAfterHours={approvalExpiresAfterHours}
        approvalOnReject={approvalOnReject}
        approvalSpendCents={approvalSpendCents}
        channelActions={channelActions.filter((action) => !action.alwaysRequiresApproval)}
      />
      {channelActions.length > 0 && (
        <section className="space-y-4" aria-labelledby="channel-actions">
          <h2 id="channel-actions">Channel permissions</h2>
          {channelActions.map((action) => (
            <WorkspaceForm
              key={action.type}
              action={saveChannelGrant}
              label={`${action.enabled ? 'Disable' : 'Enable'} ${action.label}`}
            >
              <input type="hidden" name="agentId" value={agentId} />
              <input type="hidden" name="type" value={action.type} />
              <input type="hidden" name="enabled" value={String(!action.enabled)} />
              <p>
                {action.label} · {action.enabled ? 'Enabled' : 'Disabled'}
              </p>
            </WorkspaceForm>
          ))}
        </section>
      )}
    </section>
  );
}

export function ConsentSettings({
  agentId,
  consents,
  consentRequiredTools,
  enabledTools,
}: {
  agentId: string;
  consents: Workspace['consents'];
  enabledTools: string[];
  consentRequiredTools: ConsentScope[];
}) {
  const grantedTools = new Set(enabledTools);
  return (
    <section className="access-workbench">
      <div className="editor-section-heading">
        <h2>Recipient consent</h2>
        <p className="muted">
          <Link href="/people/introductions">People introductions</Link> require agreement from both
          people on the proposed disclosure.
        </p>
      </div>
      <section className="space-y-4" aria-labelledby="people-permissions">
        <h3 id="people-permissions">People permissions</h3>
        <div className="grid gap-4 md:grid-cols-2">
          {peopleGrants.map(({ type, label, description }) => {
            const enabled = grantedTools.has(type);
            return (
              <WorkspaceForm
                key={type}
                action={savePeopleGrant}
                label={`${enabled ? 'Disable' : 'Enable'} ${label.toLowerCase()}`}
              >
                <input type="hidden" name="agentId" value={agentId} />
                <input type="hidden" name="type" value={type} />
                <input type="hidden" name="enabled" value={String(!enabled)} />
                <p>
                  <strong>{label}</strong> · {enabled ? 'Enabled' : 'Disabled'}
                </p>
                <p className="muted">{description}</p>
              </WorkspaceForm>
            );
          })}
        </div>
      </section>
      <ActionRequirementsForm
        agentId={agentId}
        idPrefix="consent-tool"
        options={consentOptions}
        selected={consentRequiredTools}
        action={saveConsentRequirements}
        label="Save consent requirements"
        legend="Require recipient consent"
        description="Choose which scenario actions require recorded permission from everyone involved. Recorded refusals and revocations always block the action."
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
        <FieldGroup className="form-fields">
          <WorkspaceField
            id="consent-recipient"
            name="recipient"
            label="Recipient ID"
            maxLength={120}
            required
            description="Use the same recipient ID the playground consent checks will receive."
          />
          <div className="form-grid">
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
          </div>
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
        <p className="muted">Review pending proposals and find past decisions.</p>
      </div>
      {reviews.length === 0 ? (
        <Empty className="border border-border py-10 md:py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No proposals awaiting review</EmptyTitle>
            <EmptyDescription>
              When an agent action needs approval, it will appear here.
            </EmptyDescription>
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
              {proposal.reason && <p>{proposal.reason}</p>}
              {proposal.status === 'pending' ? (
                <div className="policy-review-edit">
                  <WorkspaceForm action={reviewProposal} label="Approve">
                    <input type="hidden" name="agentId" value={agentId} />
                    <input type="hidden" name="intentId" value={proposal.id} />
                    <input type="hidden" name="decision" value="approved" />
                    {proposal.actionType === INTRODUCTION_REVIEW ? (
                      <blockquote className="approvals-preview">{proposal.draft}</blockquote>
                    ) : (
                      <Field>
                        <FieldLabel htmlFor={`draft-${proposal.id}`}>
                          Draft (edit before approve)
                        </FieldLabel>
                        <Textarea
                          id={`draft-${proposal.id}`}
                          name="draft"
                          rows={3}
                          defaultValue={proposal.draft ?? ''}
                          maxLength={8000}
                        />
                      </Field>
                    )}
                  </WorkspaceForm>
                  <WorkspaceForm action={reviewProposal} label="Reject">
                    <input type="hidden" name="agentId" value={agentId} />
                    <input type="hidden" name="intentId" value={proposal.id} />
                    <input type="hidden" name="decision" value="rejected" />
                  </WorkspaceForm>
                </div>
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
