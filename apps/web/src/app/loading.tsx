import { ConsolePageSkeleton } from '@/app/console-skeletons';

/**
 * Rare fallback outside the console group (e.g. login). Do not call env() —
 * Next prerenders /_global-error without CI env vars and Zod would fail the build.
 */
export default function Loading() {
  return (
    <div className="console-shell">
      <ConsolePageSkeleton />
    </div>
  );
}
