import type { ReactNode } from 'react';

import { WorkspaceHeader } from '@/app/workspace-header';
import { getPendingApprovalCount } from '@/lib/server/workspace-queries';

export const dynamic = 'force-dynamic';

export default async function IntroductionsLayout({ children }: { children: ReactNode }) {
  const pendingApprovalCount = await getPendingApprovalCount();
  return (
    <div className="agent-shell">
      <WorkspaceHeader current="/people" pendingApprovalCount={pendingApprovalCount} />
      <main className="workspace-main people-workspace" id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
