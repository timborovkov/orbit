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
  approvalExpiresAfterHours,
  approvalOnReject,
  approvalSpendCents,
}: {
  agentId: string;
  approvalTools: string[];
  approvalExpiresAfterHours: number | null;
  approvalOnReject: 'continue' | 'end';
  approvalSpendCents: number | null;
}) {
  const requiredTools = new Set(approvalTools);
  return (
    <section className="access-workbench" data-testid="approval-settings">
      <div className="editor-section-heading">
        <h2>Approval requirements</h2>
        <p className="muted">
          Off by default. Enable actions that must pause for an administrator before continuing.
          Introductions and escalations always require consent and approval.
        </p>
      </div>
      <WorkspaceForm action={saveApprovalTools} label="Save approval requirements">
        <input type="hidden" name="agentId" value={agentId} />
        <fieldset className="policy-options" aria-label="Other actions requiring approval">
          <legend className="sr-only">Other actions requiring approval</legend>
          {proposalTypes
            .filter((tool) => tool !== 'introduce' && tool !== 'escalate')
            .map((tool) => (
              <label key={tool} className="policy-option">
                <input
                  type="checkbox"
                  name="tool"
                  value={tool}
                  defaultChecked={requiredTools.has(tool)}
                />
                <span>{actionLabels[tool]}</span>
              </label>
            ))}
        </fieldset>
        <ul className="approval-fields">
          <li>
            <label htmlFor="approval-spend">Spend threshold (USD cents, optional)</label>
            <input
              id="approval-spend"
              name="approvalSpendCents"
              type="number"
              inputMode="numeric"
              min={1}
              max={100000000}
              defaultValue={approvalSpendCents ?? undefined}
            />
            <p className="field-hint">
              When set, write actions need approval once today’s recorded spend reaches this amount.
            </p>
          </li>
          <li>
            <label htmlFor="approval-expiry">Auto-reject after (hours, optional)</label>
            <input
              id="approval-expiry"
              name="approvalExpiresAfterHours"
              type="number"
              inputMode="numeric"
              min={1}
              max={720}
              defaultValue={approvalExpiresAfterHours ?? undefined}
            />
            <p className="field-hint">Leave blank to keep pending items until reviewed.</p>
          </li>
        </ul>
        <WorkspaceSelect
          id="approval-on-reject"
          name="approvalOnReject"
          label="When a proposal is rejected"
          initialValue={approvalOnReject}
          options={[
            { value: 'continue', label: 'Continue the run with the decline recorded' },
            { value: 'end', label: 'End the run' },
          ]}
        />
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
          Pending items suspend the run until approved or rejected. Edit a draft before approving
          when needed.
        </p>
      </div>
      {reviews.length === 0 ? (
        <p className="muted">No proposals awaiting review.</p>
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
                    <div className="approvals-draft">
                      <label htmlFor={`draft-${proposal.id}`}>Draft (edit before approve)</label>
                      <textarea
                        id={`draft-${proposal.id}`}
                        name="draft"
                        rows={3}
                        defaultValue={proposal.draft ?? ''}
                        maxLength={8000}
                      />
                    </div>
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
