import { reviewProposal, saveApprovalTools, saveConsent } from '@/actions/policy';
import { WorkspaceField, WorkspaceSelect } from '@/app/workspace-field';
import { WorkspaceForm } from '@/app/workspace-form';
import { proposalTypes } from '@/lib/policy/scopes';
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

export function ReviewSettings({
  agentId,
  approvalTools,
}: {
  agentId: string;
  approvalTools: string[];
}) {
  const requiredTools = new Set(approvalTools);
  return (
    <section className="access-workbench">
      <div className="editor-section-heading">
        <h2>Approval requirements</h2>
        <p className="muted">Introductions and escalations always require consent and approval.</p>
      </div>
      <WorkspaceForm action={saveApprovalTools} label="Save approval requirements">
        <input type="hidden" name="agentId" value={agentId} />
        <div className="policy-options" role="group" aria-label="Other actions requiring approval">
          {proposalTypes
            .filter((tool) => tool !== 'introduce' && tool !== 'escalate')
            .map((tool) => (
              <label key={tool}>
                <input
                  type="checkbox"
                  name="tool"
                  value={tool}
                  defaultChecked={requiredTools.has(tool)}
                />
                {actionLabels[tool]}
              </label>
            ))}
        </div>
      </WorkspaceForm>
    </section>
  );
}

export function ConsentSettings({
  agentId,
  consents,
}: {
  agentId: string;
  consents: Workspace['consents'];
}) {
  return (
    <section className="access-workbench">
      <div className="editor-section-heading">
        <h2>Recipient consent</h2>
        <p className="muted">
          Record a recipient’s choice and the source of their consent for this agent.
        </p>
      </div>
      <WorkspaceForm action={saveConsent} label="Save consent">
        <input type="hidden" name="agentId" value={agentId} />
        <WorkspaceField
          id="consent-recipient"
          name="recipient"
          label="Recipient ID"
          maxLength={120}
          required
        />
        <WorkspaceSelect
          id="consent-scope"
          name="scope"
          label="Consent scope"
          initialValue="introduce"
          options={[
            { value: 'introduce', label: 'Introductions' },
            { value: 'escalate', label: 'Escalations' },
          ]}
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
        />
      </WorkspaceForm>
      {consents.length > 0 && (
        <ul className="policy-records" aria-label="Recent consent records">
          {consents.map((record) => (
            <li key={JSON.stringify([record.recipient, record.scope])}>
              <strong>{record.recipient}</strong> · {actionLabels[record.scope]} ·{' '}
              {record.granted ? 'Granted' : 'Revoked'}
              <p className="field-hint">{record.evidence}</p>
            </li>
          ))}
        </ul>
      )}
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
        <p className="muted">No proposals awaiting review.</p>
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
