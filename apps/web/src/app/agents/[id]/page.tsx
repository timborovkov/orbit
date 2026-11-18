import { notFound } from 'next/navigation';
import { ChevronDown, History } from 'lucide-react';
import { z } from 'zod';

import { saveConfiguration } from '@/actions/workspace';
import { AccessWorkbench } from '@/app/access-workbench';
import { AgentAvatar } from '@/app/agent-avatar';
import { ConfigFields } from '@/app/config-fields';
import { PendingRunRefresh } from '@/app/pending-run-refresh';
import { PlaygroundChat } from '@/app/playground-chat';
import { ProposalReview } from '@/app/policy-settings';
import { ProfilePictureEditor } from '@/app/profile-picture-editor';
import { RunContent } from '@/app/run-content';
import { WorkspaceForm } from '@/app/workspace-form';
import { WorkspaceHeader } from '@/app/workspace-header';
import { WorkspaceTabs } from '@/app/workspace-tabs';
import { requireAdmin } from '@/lib/auth';
import { env } from '@/lib/env';
import { formatUtcTimestamp } from '@/lib/format';
import { canEnqueueSimulation, lifecycleLabels } from '@/lib/lifecycle';
import { openRouterConnectionLabel } from '@/lib/runtime/openrouter-key';
import { getAgentWorkspace } from '@/lib/server/workspace-queries';
import { storageConfigured } from '@/lib/storage/objects';

export const dynamic = 'force-dynamic';
export default async function AgentWorkspace({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const email = await requireAdmin();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const focus = z.uuid().safeParse((await searchParams).run);
  const focusRunId = focus.success ? focus.data : undefined;
  const workspace = await getAgentWorkspace(id, focusRunId);
  if (!workspace) notFound();
  const {
    agent,
    versions,
    hasAgentCredential,
    keySource,
    history,
    current,
    reviews,
    pendingApprovalCount,
    consents,
    usage,
  } = workspace;
  const lifecycle = agent.lifecycle;
  const approvalSettings = current.approvalSettings ?? agent;
  const canSimulate = canEnqueueSimulation(lifecycle);
  const viewedHistory = history;
  const hasPendingRuns = history.some(
    (run) =>
      run.displayStatus === 'queued' ||
      run.displayStatus === 'running' ||
      run.displayStatus === 'awaiting_approval',
  );
  const versionFor = (configurationId: string) =>
    versions.find((version) => version.id === configurationId)?.version;
  const configuration = (
    <section id="configuration" className="configuration-workbench">
      <WorkspaceForm
        key={current.id}
        action={saveConfiguration}
        label="Save configuration"
        saveState
      >
        <input type="hidden" name="agentId" value={id} />
        <input type="hidden" name="version" value={current.version} />
        <ConfigFields
          config={current.config}
          prefix="agent"
          identityContent={
            <ProfilePictureEditor
              id={id}
              name={agent.name}
              pictureKey={agent.pictureKey}
              configured={storageConfigured()}
            />
          }
        />
      </WorkspaceForm>
    </section>
  );
  const access = (
    <AccessWorkbench
      agentId={id}
      agentName={agent.name}
      lifecycle={lifecycle}
      budgets={agent.budgets}
      usage={usage}
      configurationVersion={current.version}
      approvalTools={approvalSettings.approvalTools}
      approvalExpiresAfterHours={approvalSettings.approvalExpiresAfterHours}
      approvalOnReject={approvalSettings.approvalOnReject}
      approvalSpendCents={approvalSettings.approvalSpendCents}
      consents={consents}
      hasAgentCredential={hasAgentCredential}
      keySource={keySource}
    />
  );
  const approvalQueue = <ProposalReview agentId={id} reviews={reviews} />;
  const playground = (
    <section id="simulation" className="playground-panel">
      <PlaygroundChat
        agentId={id}
        agentName={agent.name}
        canSimulate={canSimulate}
        lifecycle={lifecycle}
        versions={versions}
        currentConfigurationId={current.id}
        runStatuses={Object.fromEntries(history.map(({ id, status }) => [id, status]))}
      />
    </section>
  );
  const historyPanel = (
    <div className="history-workbench">
      <section id="history">
        <div className="editor-section-heading">
          <h2>Run history</h2>
          <p className="muted">
            Your latest 50 simulations, with queue status, policy outcomes and the configuration
            each one used.
          </p>
        </div>
        {!history.length && (
          <div className="history-empty">
            <History size={24} aria-hidden="true" />
            <p>No runs yet. Start in the Playground to test your agent.</p>
          </div>
        )}
        {viewedHistory.map((run) => (
          <details
            key={run.id}
            id={`run-${run.id}`}
            className="run-detail"
            open={run.id === focusRunId ? true : undefined}
          >
            <summary>
              <div>
                <span className="run-title">{run.input}</span>
                <time dateTime={run.createdAt.toISOString()}>
                  {formatUtcTimestamp(run.createdAt)} · Version {versionFor(run.configurationId)}
                  {run.job && run.job.status !== 'completed' ? ` · job ${run.job.status}` : ''}
                  {run.displayStatus !== 'deferred' && run.deferReason
                    ? ` · ${run.deferReason}`
                    : ''}
                </time>
              </div>
              <span className="state-label" title={run.deferReason ?? undefined}>
                {run.displayStatus === 'awaiting_approval'
                  ? 'Awaiting approval'
                  : run.displayStatus}
              </span>
              <ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" />
            </summary>
            <RunContent run={run} interrupted={run.interrupted} />
          </details>
        ))}
      </section>
      <section className="version-history">
        <h2>Configuration versions</h2>
        <p className="muted">Every save is a snapshot. Previous runs stay unchanged.</p>
        {versions.map((version) => (
          <details key={version.id}>
            <summary>
              <span>Version {version.version}</span>
              <time>{formatUtcTimestamp(version.createdAt)}</time>
            </summary>
            <dl className="config-snapshot">
              {Object.entries(version.config).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value || '—'}</dd>
                </div>
              ))}
            </dl>
          </details>
        ))}
      </section>
    </div>
  );
  return (
    <div className="agent-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <WorkspaceHeader name={agent.name} pendingApprovalCount={pendingApprovalCount} />
      <main className="agent-main" id="main">
        {env().AUTH_DISABLED && (
          <p className="local-auth-notice">Authentication disabled · Local development · {email}</p>
        )}
        <div className="agent-title-row">
          <div className="agent-title-identity">
            <AgentAvatar
              id={id}
              name={agent.name}
              pictureKey={agent.pictureKey}
              className="agent-monogram"
            />
            <div>
              <div className="agent-name-line">
                <h1>{agent.name}</h1>
                <span className="state-label">
                  <span className="status-dot" />
                  {lifecycleLabels[lifecycle]}
                </span>
              </div>
              <p className="muted">{current.config.role || 'Custom agent'}</p>
            </div>
          </div>
          <div className="agent-version">
            <span>Configuration v{current.version}</span>
            <span className="muted">{openRouterConnectionLabel(keySource)}</span>
          </div>
        </div>
        <PendingRunRefresh active={hasPendingRuns} />
        <WorkspaceTabs
          key={focusRunId ?? id}
          initialTab={focusRunId ? 'history' : undefined}
          items={[
            { id: 'configure', label: 'Configuration', content: configuration },
            { id: 'playground', label: 'Playground', content: playground },
            { id: 'history', label: 'History', count: history.length, content: historyPanel },
            {
              id: 'approvals',
              label: 'Approvals',
              count: reviews.filter((review) => review.status === 'pending').length,
              content: approvalQueue,
            },
            { id: 'access', label: 'Access', content: access },
          ]}
        />
      </main>
    </div>
  );
}
