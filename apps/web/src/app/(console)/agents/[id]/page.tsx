import { Suspense } from 'react';

import { notFound } from 'next/navigation';

import { z } from 'zod';

import { AgentWorkspaceHeader } from '@/app/agent-workspace-header';
import { AgentWorkspaceTabs } from '@/app/agent-workspace-tabs';
import { ApprovalPendingNotice } from '@/app/approval-pending-notice';
import { LoadingStatus } from '@/app/loading-status';
import { PendingRunRefresh } from '@/app/pending-run-refresh';
import { requireAdmin } from '@/lib/auth';
import { env } from '@/lib/env';
import { canEnqueueSimulation } from '@/lib/lifecycle';
import { ACTIVE_CRAWL_STATES, type CrawlStatus } from '@/lib/research';
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
import { getWebResearchAccess, getWebResearchActivity } from '@/lib/server/research-queries';
import { listSkillSummaries } from '@/lib/server/skills-queries';
import { getAgentWorkspace } from '@/lib/server/workspace-queries';
import { getXReplyConnection } from '@/lib/server/x-reply-connection';

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
    globalPaused,
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
    xReplyConnection,
    memory,
    webResearch,
    webResearchAccess,
  ] = await Promise.all([
    listKnowledgeDocuments(id),
    listGrantedKnowledgeLibraries(id),
    listSkillSummaries(),
    listMcpConnections(),
    getEmailInbox(id, selectedThread, emailPage, messagePage, focusMessageId),
    listFollowUpsForAgent(id),
    listActivityEventsForAgent(id),
    getXReplyConnection(id),
    listAgentMemories(id, memoryPage),
    getWebResearchActivity(
      id,
      history.map(({ id: runId }) => runId),
    ),
    getWebResearchAccess(id),
  ]);
  const lifecycle = agent.lifecycle;
  const canSimulate = canEnqueueSimulation(lifecycle);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const followUpRefresh = followUpWorkspaceRefresh({
    now,
    scheduled: followUps
      .filter((item) => item.status === 'scheduled')
      .map((item) => ({
        dueAt: item.dueAt,
        jobStatus: item.jobStatus,
        waitForReply: item.waitForEvent === 'reply',
      })),
  });
  const activeCrawlStates = new Set<CrawlStatus>(ACTIVE_CRAWL_STATES);
  const activeCrawls = webResearch.crawls.some((crawl) => activeCrawlStates.has(crawl.status));
  const hasPendingRuns = history.some(
    (run) =>
      run.displayStatus === 'queued' ||
      run.displayStatus === 'running' ||
      run.displayStatus === 'awaiting_approval',
  );
  const hasPendingKnowledge =
    knowledgeDocuments.some((doc) => doc.status === 'pending' || doc.status === 'processing') ||
    sharedLibraries.some((library) => library.pendingCount > 0);
  const hasActiveWork = hasPendingRuns || hasPendingKnowledge || activeCrawls || inbox.pending;
  const knowledgeDocumentCount =
    knowledgeDocuments.length +
    sharedLibraries.reduce((sum, library) => sum + library.documentCount, 0);

  return (
    <div className="agent-shell">
      <main className="workspace-main" id="main" tabIndex={-1}>
        {env().AUTH_DISABLED && (
          <p className="local-auth-notice">Authentication disabled · Local development · {email}</p>
        )}
        <AgentWorkspaceHeader
          id={id}
          name={agent.name}
          pictureKey={agent.pictureKey}
          role={current.config.role}
          lifecycle={lifecycle}
          version={current.version}
          keyLabel={openRouterConnectionLabel(keySource)}
        />
        <PendingRunRefresh
          active={hasActiveWork || followUpRefresh.pollFrequently}
          refreshAt={followUpRefresh.refreshAt}
          intervalMs={hasActiveWork ? undefined : followUpRefresh.intervalMs}
        />
        <ApprovalPendingNotice
          agentId={id}
          pendingCount={reviews.filter((review) => review.status === 'pending').length}
        />
        <Suspense
          fallback={
            <div className="workspace-tab-panel">
              <LoadingStatus>Loading agent workspace…</LoadingStatus>
            </div>
          }
        >
          <AgentWorkspaceTabs
            id={id}
            agent={agent}
            current={current}
            versions={versions}
            history={history}
            latestPlaygroundRun={latestPlaygroundRun}
            reviews={reviews}
            usage={usage}
            skillIds={skillIds}
            mcpSelections={mcpSelections}
            consents={consents}
            hasAgentCredential={hasAgentCredential}
            keySource={keySource}
            canSimulate={canSimulate}
            lifecycle={lifecycle}
            globalPaused={globalPaused}
            knowledgeDocuments={knowledgeDocuments}
            sharedLibraries={sharedLibraries}
            librarySkills={librarySkills}
            libraryMcp={libraryMcp}
            inbox={inbox}
            followUps={followUps}
            activityEvents={activityEvents}
            xAccount={xReplyConnection?.username ?? null}
            memory={memory}
            memoryPage={memoryPage}
            emailPage={emailPage}
            today={today}
            focusRunId={focusRunId}
            webResearch={webResearch}
            webResearchAccess={webResearchAccess}
            knowledgeDocumentCount={knowledgeDocumentCount}
            renderedAt={now.toISOString()}
          />
        </Suspense>
      </main>
    </div>
  );
}
