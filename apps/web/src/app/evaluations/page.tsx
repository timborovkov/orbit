import { EvaluationsWorkbench } from '@/app/evaluations-workbench';
import { WorkspaceHeader } from '@/app/workspace-header';
import { env } from '@/lib/env';
import { listEvaluationWorkspace } from '@/lib/server/evaluation-queries';
import { getPendingApprovalCount } from '@/lib/server/workspace-queries';

export const dynamic = 'force-dynamic';

export default async function EvaluationsPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  const params = await searchParams;
  const agentId = params.agent;
  const [workspace, pendingApprovalCount] = await Promise.all([
    listEvaluationWorkspace(agentId),
    getPendingApprovalCount(),
  ]);

  return (
    <div className="agent-shell">
      <WorkspaceHeader current="/evaluations" pendingApprovalCount={pendingApprovalCount} />
      <main className="workspace-main" id="main" tabIndex={-1}>
        {env().AUTH_DISABLED && (
          <p className="local-auth-notice" role="status">
            Authentication disabled · Local development
          </p>
        )}
        <EvaluationsWorkbench
          agentId={agentId}
          agents={workspace.agents}
          cases={workspace.cases.map((row) => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
          }))}
          comparisons={workspace.comparisons.map((row) => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
          }))}
          versions={workspace.versions}
        />
      </main>
    </div>
  );
}
