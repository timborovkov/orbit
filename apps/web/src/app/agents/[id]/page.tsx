import { Suspense } from 'react';

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { z } from 'zod';

import { saveConfiguration } from '@/actions/workspace';
import { AccessWorkbench } from '@/app/access-workbench';
import { AgentAvatar } from '@/app/agent-avatar';
import { ConfigFields } from '@/app/config-fields';
import { EmailInbox } from '@/app/email-inbox';
import { FollowUpsWorkbench } from '@/app/follow-ups-workbench';
import { HistoryWorkbench } from '@/app/history-workbench';
import { KnowledgeWorkbench } from '@/app/knowledge-workbench';
import { LoadingStatus } from '@/app/loading-status';
import { MemoryWorkbench } from '@/app/memory-workbench';
import { PendingRunRefresh } from '@/app/pending-run-refresh';
import { PlaygroundPanel } from '@/app/playground-panel';
import { ProposalReview } from '@/app/policy-settings';
import { ProfilePictureEditor } from '@/app/profile-picture-editor';
import { WorkspaceForm } from '@/app/workspace-form';
import { WorkspaceHeader } from '@/app/workspace-header';
import { WorkspaceTabs } from '@/app/workspace-tabs';
import { requireAdmin } from '@/lib/auth';
import { env } from '@/lib/env';
import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import { canEnqueueSimulation, lifecycleLabels } from '@/lib/lifecycle';
import { channelGrantOptions } from '@/lib/runtime/channels/registry';
import { followUpWorkspaceRefresh } from '@/lib/runtime/follow-ups/refresh';
import { openRouterConnectionLabel } from '@/lib/runtime/openrouter-key';
import { getEmailInbox } from '@/lib/server/email-queries';
import { listActivityEventsForAgent, listFollowUpsForAgent } from '@/lib/server/follow-up-queries';
import {
  listGrantedKnowledgeLibraries,
  listKnowledgeDocuments,
} from '@/lib/server/knowledge-queries';
import { listMcpConnections } from '@/lib/server/mcp-queries';
import { listAgentMemories } from '@/lib/server/memory-queries';
import { listSkillSummaries } from '@/lib/server/skills-queries';
import { getAgentWorkspace } from '@/lib/server/workspace-queries';
import { storageConfigured } from '@/lib/storage/objects';

interface WorkspaceSearch {
  run?: string;
  emailThread?: string;
  emailMessage?: string;
  emailPage?: string;
  messagePage?: string;
  memoryPage?: string;
}

function workspaceLocation(search: WorkspaceSearch) {
  const focusRunId = z.uuid().safeParse(search.run).data;
  const selectedThread = z.uuid().safeParse(search.emailThread).data;
  const pageNumber = z.coerce.number().int().min(1).max(100_000);
  return {
    focusRunId,
    selectedThread,
    memoryPage: pageNumber.safeParse(search.memoryPage).data ?? 1,
    focusMessageId: z.uuid().safeParse(search.emailMessage).data,
    emailPage: pageNumber.safeParse(search.emailPage).data ?? 1,
    messagePage: pageNumber.safeParse(search.messagePage).data ?? 1,
  };
}

export const dynamic = 'force-dynamic';
export default async function AgentWorkspace({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<WorkspaceSearch>;
}) {
  const email = await requireAdmin();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { focusRunId, selectedThread, focusMessageId, emailPage, messagePage, memoryPage } =
    workspaceLocation(await searchParams);
  const workspace = await getAgentWorkspace(id, focusRunId);
  if (!workspace) notFound();
  const {
    agent,
    versions,
    hasAgentCredential,
    keySource,
    history,
    latestPlaygroundRun,
    current,
    reviews,
    pendingApprovalCount,
    consents,
    usage,
    skillIds,
    mcpSelections,
  } = workspace;
  const [
    knowledgeDocuments,
    sharedLibraries,
    { items: librarySkills },
    { items: libraryMcp },
    inbox,
    followUps,
    activityEvents,
    memory,
  ] = await Promise.all([
    listKnowledgeDocuments(id),
    listGrantedKnowledgeLibraries(id),
    listSkillSummaries(),
    listMcpConnections(),
    getEmailInbox(id, selectedThread, emailPage, messagePage, focusMessageId),
    listFollowUpsForAgent(id),
    listActivityEventsForAgent(id),
    listAgentMemories(id, memoryPage),
  ]);
  const lifecycle = agent.lifecycle;
  const approvalSettings = current.approvalSettings ?? agent;
  const canSimulate = canEnqueueSimulation(lifecycle);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const followUpRefresh = followUpWorkspaceRefresh({
    now,
    scheduled: followUps
      .filter((item) => item.status === 'scheduled')
      .map((item) => ({ dueAt: item.dueAt, jobStatus: item.jobStatus })),
  });
  const hasPendingRuns = history.some(
    (run) =>
      run.displayStatus === 'queued' ||
      run.displayStatus === 'running' ||
      run.displayStatus === 'awaiting_approval',
  );
  const hasPendingKnowledge =
    knowledgeDocuments.some((doc) => doc.status === 'pending' || doc.status === 'processing') ||
    sharedLibraries.some((library) => library.pendingCount > 0);
  const knowledgeDocumentCount =
    knowledgeDocuments.length +
    sharedLibraries.reduce((sum, library) => sum + library.documentCount, 0);
  const versionFor = (configurationId: string) =>
    versions.find((version) => version.id === configurationId)?.version ?? '—';
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
  const enabledTools = new Set(agent.enabledTools);
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
      channelActions={channelGrantOptions().map((option) => ({
        ...option,
        enabled: enabledTools.has(option.type),
      }))}
      consentRequiredTools={agent.consentRequiredTools}
      enabledTools={agent.enabledTools}
      consents={consents}
      hasAgentCredential={hasAgentCredential}
      keySource={keySource}
      skills={librarySkills}
      skillIds={skillIds}
      mcpConnections={libraryMcp.map(({ id, name, url, transport, toolAllowlist, updatedAt }) => ({
        id,
        name,
        url,
        transport,
        revision: updatedAt.toISOString(),
        readOnlyTools:
          toolAllowlist?.filter((tool) => tool.readOnly).map((tool) => tool.name) ?? [],
      }))}
      mcpSelections={mcpSelections}
    />
  );
  const approvalQueue = <ProposalReview agentId={id} reviews={reviews} />;
  const playground = (
    <PlaygroundPanel
      agentId={id}
      agentName={agent.name}
      canSimulate={canSimulate}
      lifecycle={lifecycle}
      versions={versions}
      currentConfigurationId={current.id}
      history={history}
      latestRun={latestPlaygroundRun}
      versionFor={versionFor}
    />
  );
  const historyPanel = (
    <HistoryWorkbench
      agentId={id}
      history={history}
      versions={versions}
      activityEvents={activityEvents}
      focusRunId={focusRunId}
      versionFor={versionFor}
    />
  );
  return (
    <div className="agent-shell">
      <WorkspaceHeader pendingApprovalCount={pendingApprovalCount} />
      <main className="workspace-main" id="main" tabIndex={-1}>
        {env().AUTH_DISABLED && (
          <p className="local-auth-notice">Authentication disabled · Local development · {email}</p>
        )}
        <nav className="agent-breadcrumb" aria-label="Breadcrumb">
          <Link href="/#agents">Agents</Link>
        </nav>
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
        <PendingRunRefresh
          active={
            hasPendingRuns || hasPendingKnowledge || inbox.pending || followUpRefresh.pollFrequently
          }
          refreshAt={followUpRefresh.refreshAt}
        />
        <Suspense
          fallback={
            <div className="workspace-tab-panel">
              <LoadingStatus>Loading agent workspace…</LoadingStatus>
            </div>
          }
        >
          <WorkspaceTabs
            key={id}
            items={[
              { id: 'configure', label: 'Configuration', content: configuration },
              { id: 'playground', label: 'Playground', content: playground },
              {
                id: 'knowledge',
                label: 'Knowledge',
                count: knowledgeDocumentCount,
                content: (
                  <KnowledgeWorkbench
                    agentId={id}
                    documents={knowledgeDocuments}
                    sharedLibraries={sharedLibraries}
                    storageReady={storageConfigured()}
                    searchEnabled={agent.enabledTools.includes(KNOWLEDGE_SEARCH_TOOL)}
                  />
                ),
              },
              {
                id: 'memory',
                label: 'Memory',
                content: (
                  <MemoryWorkbench
                    agentId={id}
                    rows={memory.rows}
                    page={memoryPage}
                    hasMore={memory.hasMore}
                    today={today}
                    retention={{
                      factDays: agent.memoryFactRetentionDays,
                      noteDays: agent.memoryNoteRetentionDays,
                      outcomeDays: agent.memoryOutcomeRetentionDays,
                      intervalDays: agent.memoryMaintenanceIntervalDays,
                    }}
                  />
                ),
              },
              {
                id: 'email',
                label: 'Email',
                content: (
                  <EmailInbox
                    agentId={id}
                    inbox={inbox}
                    page={emailPage}
                    messagePage={inbox.messagePage}
                  />
                ),
              },
              {
                id: 'follow-ups',
                label: 'Follow-ups',
                count: followUps.length,
                content: <FollowUpsWorkbench agentId={id} items={followUps} />,
              },
              {
                id: 'history',
                label: 'History',
                count: history.length + activityEvents.length,
                content: historyPanel,
              },
              {
                id: 'approvals',
                label: 'Approvals',
                count: reviews.filter((review) => review.status === 'pending').length,
                content: approvalQueue,
              },
              { id: 'access', label: 'Access', content: access },
            ]}
          />
        </Suspense>
      </main>
    </div>
  );
}
