import { Suspense } from 'react';

import { saveConfiguration } from '@/actions/workspace';
import { AccessWorkbench } from '@/app/access-workbench';
import type { BudgetUsageView } from '@/app/budget-settings';
import { ConfigFields } from '@/app/config-fields';
import { EmailInbox } from '@/app/email-inbox';
import { FollowUpsWorkbench } from '@/app/follow-ups-workbench';
import { HistoryWorkbench } from '@/app/history-workbench';
import { KnowledgeWorkbench } from '@/app/knowledge-workbench';
import { LoadingStatus } from '@/app/loading-status';
import { MemoryWorkbench } from '@/app/memory-workbench';
import { PlaygroundPanel } from '@/app/playground-panel';
import { ProposalReview } from '@/app/policy-settings';
import { ProfilePictureEditor } from '@/app/profile-picture-editor';
import { WorkspaceForm } from '@/app/workspace-form';
import { WorkspaceTabs } from '@/app/workspace-tabs';
import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import type { LifecycleState } from '@/lib/lifecycle';
import { channelGrantOptions } from '@/lib/runtime/channels/registry';
import { isCommitmentTool } from '@/lib/runtime/follow-ups/types';
import type { OpenRouterKeySource } from '@/lib/runtime/openrouter-key';
import type { getEmailInbox } from '@/lib/server/email-queries';
import type {
  listActivityEventsForAgent,
  listFollowUpsForAgent,
} from '@/lib/server/follow-up-queries';
import type {
  listGrantedKnowledgeLibraries,
  listKnowledgeDocuments,
} from '@/lib/server/knowledge-queries';
import type { listMcpConnections } from '@/lib/server/mcp-queries';
import type { listAgentMemories } from '@/lib/server/memory-queries';
import type { getWebResearchAccess, getWebResearchActivity } from '@/lib/server/research-queries';
import type { listSkillSummaries } from '@/lib/server/skills-queries';
import type { getAgentWorkspace } from '@/lib/server/workspace-queries';
import { storageConfigured } from '@/lib/storage/objects';

type Workspace = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>;

export function AgentWorkspaceTabs({
  id,
  agent,
  current,
  versions,
  history,
  latestPlaygroundRun,
  reviews,
  usage,
  skillIds,
  mcpSelections,
  consents,
  hasAgentCredential,
  keySource,
  canSimulate,
  lifecycle,
  knowledgeDocuments,
  sharedLibraries,
  librarySkills,
  libraryMcp,
  inbox,
  followUps,
  activityEvents,
  xAccount,
  memory,
  memoryPage,
  emailPage,
  today,
  focusRunId,
  webResearch,
  webResearchAccess,
  knowledgeDocumentCount,
}: {
  id: string;
  agent: Workspace['agent'];
  current: Workspace['current'];
  versions: Workspace['versions'];
  history: Workspace['history'];
  latestPlaygroundRun: Workspace['latestPlaygroundRun'];
  reviews: Workspace['reviews'];
  usage: BudgetUsageView;
  skillIds: Workspace['skillIds'];
  mcpSelections: Workspace['mcpSelections'];
  consents: Workspace['consents'];
  hasAgentCredential: boolean;
  keySource: OpenRouterKeySource;
  canSimulate: boolean;
  lifecycle: LifecycleState;
  knowledgeDocuments: Awaited<ReturnType<typeof listKnowledgeDocuments>>;
  sharedLibraries: Awaited<ReturnType<typeof listGrantedKnowledgeLibraries>>;
  librarySkills: Awaited<ReturnType<typeof listSkillSummaries>>['items'];
  libraryMcp: Awaited<ReturnType<typeof listMcpConnections>>['items'];
  inbox: Awaited<ReturnType<typeof getEmailInbox>>;
  followUps: Awaited<ReturnType<typeof listFollowUpsForAgent>>;
  activityEvents: Awaited<ReturnType<typeof listActivityEventsForAgent>>;
  xAccount: string | null;
  memory: Awaited<ReturnType<typeof listAgentMemories>>;
  memoryPage: number;
  emailPage: number;
  today: string;
  focusRunId?: string;
  webResearch: Awaited<ReturnType<typeof getWebResearchActivity>>;
  webResearchAccess: Awaited<ReturnType<typeof getWebResearchAccess>>;
  knowledgeDocumentCount: number;
}) {
  const approvalSettings = current.approvalSettings ?? agent;
  const versionFor = (configurationId: string) =>
    versions.find((version) => version.id === configurationId)?.version ?? '—';
  const enabledTools = new Set(agent.enabledTools);

  return (
    <WorkspaceTabs
      key={id}
      items={[
        {
          id: 'configure',
          label: 'Configuration',
          content: (
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
          ),
        },
        {
          id: 'playground',
          label: 'Playground',
          content: (
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
          ),
        },
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
          content: (
            <HistoryWorkbench
              agentId={id}
              history={history}
              versions={versions}
              activityEvents={activityEvents}
              webResearch={webResearch}
              focusRunId={focusRunId}
              versionFor={versionFor}
            />
          ),
        },
        {
          id: 'approvals',
          label: 'Approvals',
          count: reviews.filter((review) => review.status === 'pending').length,
          content: <ProposalReview agentId={id} reviews={reviews} />,
        },
        {
          id: 'access',
          label: 'Access',
          content: (
            <Suspense fallback={<LoadingStatus>Loading access…</LoadingStatus>}>
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
                xAccount={xAccount}
                enabledCommitmentTools={agent.enabledTools.filter(isCommitmentTool)}
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
                mcpConnections={libraryMcp.map(
                  ({ id: connectionId, name, url, transport, toolAllowlist, updatedAt }) => ({
                    id: connectionId,
                    name,
                    url,
                    transport,
                    revision: updatedAt.toISOString(),
                    readOnlyTools:
                      toolAllowlist?.filter((tool) => tool.readOnly).map((tool) => tool.name) ?? [],
                  }),
                )}
                mcpSelections={mcpSelections}
                research={webResearchAccess}
              />
            </Suspense>
          ),
        },
      ]}
    />
  );
}
