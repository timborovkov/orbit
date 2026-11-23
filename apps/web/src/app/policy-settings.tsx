import { Inbox } from 'lucide-react';

import {
  reviewProposal,
  saveChannelGrant,
  saveConsent,
  saveConsentRequirements,
} from '@/actions/policy';
import { saveXReplyConnection } from '@/actions/x-reply';
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { ConsentScope } from '@/lib/policy/scopes';
import { X_REPLY_ACTION, xReplyDraftLength } from '@/lib/runtime/x/reply-input';
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
  xAccount,
}: {
  agentId: string;
  configurationVersion: number;
  approvalTools: string[];
  approvalExpiresAfterHours: number | null;
  approvalOnReject: 'continue' | 'end';
  approvalSpendCents: number | null;
  xAccount: string | null;
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
          Introductions and escalations are optional here; recipient consent is configured
          separately.
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
      <section className="space-y-4" aria-labelledby="x-reply-account">
        <h2 id="x-reply-account">X account</h2>
        <p className="muted">
          {xAccount ? `Connected as @${xAccount}` : 'Connect an X user to deliver replies.'} In
          Live, the X reply grant sends eligible replies automatically unless an approval rule
          applies.
        </p>
        <WorkspaceForm
          action={saveXReplyConnection}
          label={xAccount ? 'Replace X token' : 'Connect X account'}
        >
          <input type="hidden" name="agentId" value={agentId} />
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="x-user-token">X user access token</FieldLabel>
              <Input
                id="x-user-token"
                name="token"
                type="password"
                autoComplete="new-password"
                aria-describedby="x-user-token-help"
                required
                maxLength={4096}
              />
              <FieldDescription id="x-user-token-help">
                Use a user token with tweet.read, tweet.write and users.read access.
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <input type="checkbox" id="x-platform-approval" name="platformApproval" required />
              <FieldLabel htmlFor="x-platform-approval">
                X has approved this account for AI replies.
              </FieldLabel>
            </Field>
          </FieldGroup>
        </WorkspaceForm>
        {xAccount && (
          <WorkspaceForm action={saveXReplyConnection} label="Disconnect X account">
            <input type="hidden" name="agentId" value={agentId} />
            <input type="hidden" name="disconnect" value="true" />
          </WorkspaceForm>
        )}
      </section>
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
        <FieldGroup className="form-fields">
          <WorkspaceField
            id="consent-recipient"
            name="recipient"
            label="Recipient ID"
            maxLength={120}
            required
            description="For X replies, use x: followed by the author’s numeric X user ID."
          />
          <div className="form-grid">
            <WorkspaceSelect
              id="consent-scope"
              name="scope"
              label="Consent scope"
              initialValue="introduce"
              options={[...consentOptions, { value: X_REPLY_ACTION, label: 'X replies' }]}
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
        <p className="muted">
          Pending items suspend the run until approved or rejected. Edit a draft before approving
          when needed.
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
              {proposal.recipients.length > 0 && (
                <p className="muted">{proposal.recipients.join(' · ')}</p>
              )}
              {proposal.reason && <p>{proposal.reason}</p>}
              {proposal.status === 'pending' ? (
                <div className="policy-review-edit">
                  <WorkspaceForm action={reviewProposal} label="Approve">
                    <input type="hidden" name="agentId" value={agentId} />
                    <input type="hidden" name="intentId" value={proposal.id} />
                    <input type="hidden" name="decision" value="approved" />
                    <Field>
                      <FieldLabel htmlFor={`draft-${proposal.id}`}>
                        Draft (edit before approve)
                      </FieldLabel>
                      <Textarea
                        id={`draft-${proposal.id}`}
                        name="draft"
                        rows={3}
                        defaultValue={proposal.draft ?? ''}
                        maxLength={
                          proposal.actionType === X_REPLY_ACTION ? xReplyDraftLength : 8000
                        }
                      />
                    </Field>
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
