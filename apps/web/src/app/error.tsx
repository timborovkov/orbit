'use client';
import { Button } from '../components/ui/button';
export default function WorkspaceError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="route-state">
      <div>
        <h1>Workspace unavailable</h1>
        <p>
          Orbit could not load your workspace or save the last change. Check the connection and try
          again.
        </p>
        <Button onClick={reset}>Try again</Button>
      </div>
    </main>
  );
}
