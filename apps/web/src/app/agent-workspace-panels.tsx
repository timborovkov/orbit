import type { ReactNode } from 'react';

import { EmailInbox } from '@/app/email-inbox';
import { FollowUpsWorkbench } from '@/app/follow-ups-workbench';
import { KnowledgeWorkbench } from '@/app/knowledge-workbench';
import { MemoryWorkbench } from '@/app/memory-workbench';
import { KNOWLEDGE_SEARCH_TOOL } from '@/lib/knowledge/types';
import { storageConfigured } from '@/lib/storage/objects';

export function buildAgentWorkspaceTabs(input: {
  id: string;
  enabledTools: string[];
  memoryFactRetentionDays: number | null;
  memoryNoteRetentionDays: number | null;
  memoryOutcomeRetentionDays: number | null;
  memoryMaintenanceIntervalDays: 1 | 7;
  knowledgeDocuments: React.ComponentProps<typeof KnowledgeWorkbench>['documents'];
  sharedLibraries: React.ComponentProps<typeof KnowledgeWorkbench>['sharedLibraries'];
  knowledgeDocumentCount: number;
  memoryRows: React.ComponentProps<typeof MemoryWorkbench>['rows'];
  memoryPage: number;
  memoryHasMore: boolean;
  today: string;
  inbox: React.ComponentProps<typeof EmailInbox>['inbox'];
  emailPage: number;
  followUps: React.ComponentProps<typeof FollowUpsWorkbench>['items'];
  historyCount: number;
  historyPanel: ReactNode;
  configuration: ReactNode;
  playground: ReactNode;
  access: ReactNode;
  approvalQueue: ReactNode;
  pendingApprovals: number;
}): { id: string; label: string; count?: number; content: ReactNode }[] {
  return [
    { id: 'configure', label: 'Configuration', content: input.configuration },
    { id: 'playground', label: 'Playground', content: input.playground },
    {
      id: 'knowledge',
      label: 'Knowledge',
      count: input.knowledgeDocumentCount,
      content: (
        <KnowledgeWorkbench
          agentId={input.id}
          documents={input.knowledgeDocuments}
          sharedLibraries={input.sharedLibraries}
          storageReady={storageConfigured()}
          searchEnabled={input.enabledTools.includes(KNOWLEDGE_SEARCH_TOOL)}
        />
      ),
    },
    {
      id: 'memory',
      label: 'Memory',
      content: (
        <MemoryWorkbench
          agentId={input.id}
          rows={input.memoryRows}
          page={input.memoryPage}
          hasMore={input.memoryHasMore}
          today={input.today}
          retention={{
            factDays: input.memoryFactRetentionDays,
            noteDays: input.memoryNoteRetentionDays,
            outcomeDays: input.memoryOutcomeRetentionDays,
            intervalDays: input.memoryMaintenanceIntervalDays,
          }}
        />
      ),
    },
    {
      id: 'email',
      label: 'Email',
      content: (
        <EmailInbox
          agentId={input.id}
          inbox={input.inbox}
          page={input.emailPage}
          messagePage={input.inbox.messagePage}
        />
      ),
    },
    {
      id: 'follow-ups',
      label: 'Follow-ups',
      count: input.followUps.length,
      content: <FollowUpsWorkbench agentId={input.id} items={input.followUps} />,
    },
    {
      id: 'history',
      label: 'History',
      count: input.historyCount,
      content: input.historyPanel,
    },
    {
      id: 'approvals',
      label: 'Approvals',
      count: input.pendingApprovals,
      content: input.approvalQueue,
    },
    { id: 'access', label: 'Access', content: input.access },
  ];
}
