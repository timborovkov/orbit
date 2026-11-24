import { BrandMark } from '@/app/brand-mark';
import { LoadingStatus } from '@/app/loading-status';

export default function Loading() {
  return (
    <main className="grid min-h-dvh place-items-center p-6" aria-label="Orbit">
      <div className="grid justify-items-center gap-4">
        <BrandMark size={40} />
        <LoadingStatus>Loading Orbit…</LoadingStatus>
      </div>
    </main>
  );
}
