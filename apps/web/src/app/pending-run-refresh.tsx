'use client';

import { useEffect } from 'react';

import { useRouter } from 'next/navigation';

/** Browsers clamp setTimeout delays above ~24.8 days; re-schedule after that. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Soft-refresh the agent workspace while work is in flight. Time-only
 * reminders schedule the next refresh at their deadline.
 */
export function PendingRunRefresh({
  active,
  refreshAt,
  intervalMs = 2000,
}: {
  active: boolean;
  refreshAt?: Date | string | null;
  intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (active) {
      const id = setInterval(() => {
        router.refresh();
      }, intervalMs);
      return () => {
        clearInterval(id);
      };
    }

    if (refreshAt === null || refreshAt === undefined) return;
    const at = typeof refreshAt === 'string' ? new Date(refreshAt) : refreshAt;
    if (Number.isNaN(at.getTime())) return;
    const delay = Math.max(0, at.getTime() - Date.now());
    const id = setTimeout(
      () => {
        router.refresh();
      },
      Math.min(delay, MAX_TIMEOUT_MS),
    );
    return () => {
      clearTimeout(id);
    };
  }, [active, intervalMs, refreshAt, router]);
  return null;
}
