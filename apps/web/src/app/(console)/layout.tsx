import { type ReactNode, Suspense } from 'react';

import { ConsoleNavHeader } from '@/app/console-nav-header';
import { WorkspaceHeader } from '@/app/workspace-header';
import { env } from '@/lib/env';
import { getPendingApprovalCount } from '@/lib/server/workspace-queries';

export const dynamic = 'force-dynamic';

async function PendingHeader() {
  const pendingApprovalCount = await getPendingApprovalCount();
  return (
    <ConsoleNavHeader
      pendingApprovalCount={pendingApprovalCount}
      authDisabled={env().AUTH_DISABLED}
    />
  );
}

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <div className="console-shell">
      <Suspense fallback={<WorkspaceHeader pendingApprovalCount={0} />}>
        <PendingHeader />
      </Suspense>
      {children}
    </div>
  );
}
