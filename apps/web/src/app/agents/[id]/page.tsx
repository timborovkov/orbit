import { notFound } from 'next/navigation';
import { ChevronDown, FlaskConical, History, ShieldCheck } from 'lucide-react';
import { z } from 'zod';

import { runSimulation, saveConfiguration } from '@/actions/workspace';
import { AccessPanel } from '@/app/access-panel';
import { AgentAvatar } from '@/app/agent-avatar';
import { BudgetSettings } from '@/app/budget-settings';
import { ConfigFields } from '@/app/config-fields';
import { LifecycleControls } from '@/app/lifecycle-controls';
import { PendingRunRefresh } from '@/app/pending-run-refresh';
import { ConsentSettings, ProposalReview, ReviewSettings } from '@/app/policy-settings';
import { ProfilePictureEditor } from '@/app/profile-picture-editor';
import { McpPicker, SkillPicker } from '@/app/resource-pickers';
import { RunContent } from '@/app/run-content';
import { WorkspaceField, WorkspaceSelect } from '@/app/workspace-field';
import { WorkspaceForm } from '@/app/workspace-form';
import { WorkspaceHeader } from '@/app/workspace-header';
import { WorkspaceTabs } from '@/app/workspace-tabs';
import { requireAdmin } from '@/lib/auth';
import { env } from '@/lib/env';
import { formatUtcTimestamp } from '@/lib/format';
import { canEnqueueSimulation, lifecycleLabels } from '@/lib/lifecycle';
import { openRouterConnectionLabel } from '@/lib/runtime/openrouter-key';
import { listMcpConnections } from '@/lib/server/mcp-queries';
import { listSkillSummaries } from '@/lib/server/skills-queries';
import { getAgentWorkspace } from '@/lib/server/workspace-queries';
import { storageConfigured } from '@/lib/storage/objects';

export const dynamic = 'force-dynamic';
export default async function AgentWorkspace({ params }: { params: Promise<{ id: string }> }) {
  const email = await requireAdmin();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const workspace = await getAgentWorkspace(id);
  if (!workspace) notFound();
  const {
    agent,
    versions,
    hasAgentCredential,
    keySource,
    history,
    current,
    reviews,
    consents,
    usage,
    skillIds,
    mcpConnectionIds,
  } = workspace;
  const [{ items: librarySkills }, { items: libraryMcp }] = await Promise.all([
    listSkillSummaries(),
    listMcpConnections(),
  ]);
  const lifecycle = agent.lifecycle;
  const canSimulate = canEnqueueSimulation(lifecycle);
  const viewedHistory = history;
  const latest = history.at(0);
  const hasPendingRuns = history.some(
    (run) => run.displayStatus === 'queued' || run.displayStatus === 'running',
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
    <div className="access-stack">
      <LifecycleControls agentId={id} lifecycle={lifecycle} />
      <BudgetSettings agentId={id} budgets={agent.budgets} usage={usage} />
      <ReviewSettings agentId={id} approvalTools={agent.approvalTools} />
      <ConsentSettings agentId={id} consents={consents} />
      <SkillPicker agentId={id} skills={librarySkills} selectedIds={skillIds} />
      <McpPicker agentId={id} connections={libraryMcp} selectedIds={mcpConnectionIds} />
      <AccessPanel
        agentId={id}
        agentName={agent.name}
        hasAgentCredential={hasAgentCredential}
        keySource={keySource}
      />
    </div>
  );
  const approvalQueue = <ProposalReview agentId={id} reviews={reviews} />;
  const playground = (
    <div className="playground-grid">
      <section id="simulation" className="simulation-composer">
        <div className="editor-section-heading">
          <h2>Test a conversation</h2>
          <p className="muted">See how {agent.name} would respond to a post or question.</p>
        </div>
        {!canSimulate && (
          <div className="run-notice">
            <ShieldCheck size={18} aria-hidden="true" />
            <p>
              {lifecycle === 'paused'
                ? 'This agent is paused. Resume it under Access before queueing simulations.'
                : 'This agent is stopped. Change its lifecycle under Access before queueing simulations.'}
            </p>
          </div>
        )}
        <WorkspaceForm action={runSimulation} label="Queue simulation" disabled={!canSimulate}>
          <input type="hidden" name="agentId" value={id} />
          <WorkspaceSelect
            key={current.id}
            id="run-version"
            name="configurationId"
            label="Configuration version"
            initialValue={current.id}
            options={versions.map((version) => ({
              value: version.id,
              label: `Version ${version.version} · ${version.config.name}`,
            }))}
          />
          <WorkspaceField
            id="run-input"
            name="input"
            label="Post or question"
            required
            multiline
            maxLength={16000}
            rows={9}
          />
          <details className="policy-recipients">
            <summary>Recipients for consent checks</summary>
            <WorkspaceField
              id="run-recipient"
              name="recipient"
              label="Recipient ID"
              maxLength={120}
            />
            <WorkspaceField
              id="run-other-recipient"
              name="otherRecipient"
              label="Second recipient ID (introductions)"
              maxLength={120}
            />
            <p className="field-hint">Use the same IDs as the consent records in Access.</p>
          </details>
        </WorkspaceForm>
        <p className="simulation-note">
          <ShieldCheck size={15} aria-hidden="true" />
          <span>
            Paid model inference runs on the Bun worker. Nothing is posted or sent. Save your
            configuration before testing.
          </span>
        </p>
      </section>
      <section className="simulation-result" aria-labelledby="latest-result-title">
        <div className="result-heading">
          <h2 id="latest-result-title">Latest result</h2>
          {latest && (
            <span className="state-label">
              v{versionFor(latest.configurationId)} · {latest.displayStatus}
            </span>
          )}
        </div>
        {latest ? (
          <RunContent run={latest} interrupted={latest.interrupted} />
        ) : (
          <div className="simulation-empty">
            <FlaskConical size={30} strokeWidth={1.25} aria-hidden="true" />
            <h3>A safe place to try things</h3>
            <p>
              Paste an input and queue a simulation. Evaluation, proposed actions and drafts will
              appear here once the worker finishes.
            </p>
          </div>
        )}
      </section>
    </div>
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
          <details key={run.id} className="run-detail">
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
                {run.displayStatus}
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
      <WorkspaceHeader name={agent.name} />
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
