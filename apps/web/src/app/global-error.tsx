'use client';

import { useEffect } from 'react';

import * as Sentry from '@sentry/nextjs';

import { Button } from '@/components/ui/button';

import '@/app/globals.css';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="route-state">
          <div>
            <h1>Workspace unavailable</h1>
            <p>
              Orbit could not load your workspace or save the last change. Check the connection and
              try again.
            </p>
            <Button onClick={reset}>Try again</Button>
          </div>
        </main>
      </body>
    </html>
  );
}
