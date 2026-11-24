'use client';

import Link from 'next/link';

import { Clock3 } from 'lucide-react';

export function ApprovalPendingNotice({
  agentId,
  pendingCount,
}: {
  agentId: string;
  pendingCount: number;
}) {
  if (pendingCount <= 0) return null;
  const label =
    pendingCount === 1
      ? '1 proposal is waiting for approval.'
      : `${pendingCount} proposals are waiting for approval.`;
  return (
    <div className="approval-pending-notice" role="status">
      <Clock3 size={16} aria-hidden="true" />
      <p>
        {label}{' '}
        <Link href={`/approvals?agent=${agentId}`} prefetch={false}>
          Review in Approvals
        </Link>
        {' · '}
        <Link href={`?tab=approvals`} scroll={false} prefetch={false}>
          Open agent queue
        </Link>
      </p>
    </div>
  );
}
