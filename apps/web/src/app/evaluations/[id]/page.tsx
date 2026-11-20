import { notFound } from 'next/navigation';

import { EvaluationComparisonView } from '@/app/evaluation-comparison-view';
import { WorkspaceHeader } from '@/app/workspace-header';
import { env } from '@/lib/env';
import { getEvaluationComparison } from '@/lib/server/evaluation-queries';
import { getPendingApprovalCount } from '@/lib/server/workspace-queries';

export const dynamic = 'force-dynamic';

export default async function EvaluationComparisonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, pendingApprovalCount] = await Promise.all([
    getEvaluationComparison(id),
    getPendingApprovalCount(),
  ]);
  if (!detail) notFound();

  return (
    <div className="agent-shell">
      <WorkspaceHeader current="/evaluations" pendingApprovalCount={pendingApprovalCount} />
      <main className="workspace-main" id="main" tabIndex={-1}>
        {env().AUTH_DISABLED && (
          <p className="local-auth-notice" role="status">
            Authentication disabled · Local development
          </p>
        )}
        <EvaluationComparisonView detail={detail} />
      </main>
    </div>
  );
}
