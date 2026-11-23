import Link from 'next/link';

import { z } from 'zod';

import { ApprovalsFilter } from '@/app/approvals-filter';
import { ApprovalsInbox } from '@/app/approvals-inbox';
import { WorkspaceHeader } from '@/app/workspace-header';
import { requireAdmin } from '@/lib/auth';
import { getApprovalsInbox } from '@/lib/server/workspace-queries';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string; run?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const filter = z.uuid().safeParse(params.agent);
  const run = z.uuid().safeParse(params.run);
  const filterAgentId = filter.success ? filter.data : undefined;
  const filterRunId = run.success ? run.data : undefined;
  const { team, items, pendingCount, totalPendingCount } = await getApprovalsInbox(
    filterAgentId,
    filterRunId,
  );
  const renderedAt = new Date().toISOString();
  const pending = items.filter((item) => item.status === 'pending');
  const resolved = items.filter((item) => item.status !== 'pending');

  return (
    <div className="app-shell" data-testid="approvals-page">
      <WorkspaceHeader current="/approvals" pendingApprovalCount={totalPendingCount} />
      <main id="main" tabIndex={-1} className="workspace-main approvals-dashboard">
        <div className="page-heading">
          <div>
            <h1>Approvals</h1>
            <p className="muted">Review pending proposals and see past decisions.</p>
          </div>
          <span className="runtime-status" aria-live="polite">
            {pendingCount} pending
          </span>
        </div>

        <ApprovalsFilter agents={team} filterAgentId={filterAgentId ?? null} />
        {filterRunId && (
          <p className="muted">
            Showing proposals for one run.{' '}
            <Link href={filterAgentId ? `/approvals?agent=${filterAgentId}` : '/approvals'}>
              Clear run filter
            </Link>
          </p>
        )}
        <ApprovalsInbox
          key={`${filterAgentId ?? ''}:${filterRunId ?? ''}`}
          pending={pending}
          resolved={resolved}
          renderedAt={renderedAt}
        />
      </main>
    </div>
  );
}
