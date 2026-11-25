import { ConsolePageSkeleton } from '@/app/console-skeletons';
import { WorkspaceHeader } from '@/app/workspace-header';
import { env } from '@/lib/env';

/** Rare fallback outside the console group; still avoids a blank full-page flash. */
export default function Loading() {
  return (
    <div className="console-shell">
      <WorkspaceHeader pendingApprovalCount={0} authDisabled={env().AUTH_DISABLED} />
      <ConsolePageSkeleton />
    </div>
  );
}
