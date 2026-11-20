'use client';

import { useEffect } from 'react';

import { useRouter } from 'next/navigation';

/** Browsers clamp setTimeout delays above ~24.8 days; re-schedule after that. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Soft-refresh the agent workspace while runs or knowledge jobs are in flight.
 * When only a future follow-up is waiting, schedule a single refresh around its
 * due time instead of polling every two seconds for the whole delay.
 */
export function PendingRunRefresh({
  active,
  refreshAt,
}: {
  active: boolean;
  refreshAt?: Date | string | null;
}) {
  const router = useRouter();
  useEffect(() => {
    if (active) {
      const id = setInterval(() => {
        router.refresh();
      }, 2000);
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
  }, [active, refreshAt, router]);
  return null;
}
