'use client';

import { useEffect, useState, useTransition } from 'react';

import { usePathname } from 'next/navigation';

import { fetchPendingApprovalCount } from '@/actions/workspace';
import { WorkspaceHeader } from '@/app/workspace-header';
import {
  currentConsoleNavFromPath,
  PENDING_APPROVAL_COUNT_POLL_MS,
  resolvedPendingApprovalCount,
} from '@/lib/runtime/console-nav';

export function ConsoleNavHeader({
  pendingApprovalCount,
  authDisabled,
}: {
  pendingApprovalCount: number;
  authDisabled: boolean;
}) {
  const pathname = usePathname();
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [liveForServerCount, setLiveForServerCount] = useState<number | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;

    function refresh() {
      startTransition(async () => {
        try {
          const next = await fetchPendingApprovalCount();
          if (cancelled) return;
          setLiveCount(next);
          setLiveForServerCount(pendingApprovalCount);
        } catch {
          // Keep the last known count; the next navigation/focus/poll retries.
        }
      });
    }

    refresh();

    const onFocus = () => {
      refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    const poll = window.setInterval(refresh, PENDING_APPROVAL_COUNT_POLL_MS);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(poll);
    };
  }, [pathname, pendingApprovalCount]);

  const count = resolvedPendingApprovalCount(pendingApprovalCount, liveCount, liveForServerCount);

  return (
    <WorkspaceHeader
      current={currentConsoleNavFromPath(pathname)}
      pendingApprovalCount={count}
      authDisabled={authDisabled}
    />
  );
}
