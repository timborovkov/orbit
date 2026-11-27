import Link from 'next/link';

import { TriangleAlert } from 'lucide-react';

import { savePeopleGrant } from '@/actions/introductions';
import { saveChannelGrant, saveConsent, saveConsentRequirements } from '@/actions/policy';
import { saveXReplyConnection } from '@/actions/x-reply';
import { ActionRequirementsForm } from '@/app/action-requirements-form';
import { ApprovalToolsForm } from '@/app/approval-tools-form';
import { WorkspaceField, WorkspaceSelect } from '@/app/workspace-field';
import { WorkspaceForm } from '@/app/workspace-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { ConsentScope } from '@/lib/policy/scopes';
import { peopleGrants } from '@/lib/runtime/introductions/types';
import { X_REPLY_ACTION } from '@/lib/runtime/x/reply-input';
import type { getAgentWorkspace } from '@/lib/server/workspace-queries';

type Workspace = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>;

const actionLabels = {
  introduce: 'Introductions',
  escalate: 'Escalations',
  [X_REPLY_ACTION]: 'X replies',
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
        <h2>Approval rules</h2>
        <p className="muted">Actions that must wait for an administrator before continuing.</p>
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
      <section
        className="live-sending"
        data-testid="live-sending"
        aria-labelledby="live-sending-title"
      >
        <div className="live-sending-header">
          <TriangleAlert className="live-sending-icon" size={18} aria-hidden="true" />
          <div>
            <h3 id="live-sending-title">Live sending</h3>
            <p>
              These controls can publish to X when the agent is Live. Review the connected account
              and permissions before changing them.
            </p>
          </div>
        </div>
        <div className="access-card-stack">
          {channelActions.length > 0 && (
            <Card className="access-card shadow-none">
              <CardHeader className="pb-3">
                <CardTitle className="text-base" role="heading" aria-level={4}>
                  Channel permissions
                </CardTitle>
                <CardDescription>
                  Allow specific outbound actions on connected channels.
                </CardDescription>
              </CardHeader>
              <CardContent className="access-card-stack">
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
              </CardContent>
            </Card>
          )}
          <Card className="access-card shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="text-base" role="heading" aria-level={4}>
                X account
              </CardTitle>
              <CardDescription>
                {xAccount
                  ? `Connected as @${xAccount}. In Live, eligible replies can send unless an approval rule applies.`
                  : 'Connect an X user to deliver replies. In Live, eligible replies can send unless an approval rule applies.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="access-card-stack">
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
                    <input
                      type="checkbox"
                      id="x-platform-approval"
                      name="platformApproval"
                      required
                    />
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
            </CardContent>
          </Card>
        </div>
      </section>
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
        description="Actions that need recorded permission from everyone involved."
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
            description="For X replies: x: plus the author’s numeric user ID."
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
            description="Link or note for where this was recorded."
          />
        </FieldGroup>
      </WorkspaceForm>
    </section>
  );
}
