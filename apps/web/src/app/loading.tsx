import Image from 'next/image';

import { LoadingStatus } from '@/app/loading-status';

export default function Loading() {
  return (
    <main className="grid min-h-dvh place-items-center p-6" aria-label="Orbit">
      <div className="grid justify-items-center gap-4">
        <Image src="/icon.svg" alt="" width={40} height={40} />
        <LoadingStatus>Loading Orbit…</LoadingStatus>
      </div>
    </main>
  );
}
