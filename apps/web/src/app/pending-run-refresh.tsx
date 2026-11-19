'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Soft-refresh the agent workspace while runs or knowledge jobs are in flight. */
export function PendingRunRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      router.refresh();
    }, 2000);
    return () => {
      clearInterval(id);
    };
  }, [active, router]);
  return null;
}
