'use client';

import { RotateCcw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { playgroundBlockRetryLabel } from '@/lib/runtime/playground-block';

export function PlaygroundBlockNotice({
  notice,
  canRetry,
  onRetry,
}: {
  notice: string;
  canRetry: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="playground-block-notice" role="alert">
      <TriangleAlert size={16} aria-hidden="true" />
      <div className="playground-block-copy">
        <p>{notice}</p>
        <Button type="button" size="sm" variant="outline" disabled={!canRetry} onClick={onRetry}>
          <RotateCcw size={14} aria-hidden="true" />
          {playgroundBlockRetryLabel(notice)}
        </Button>
      </div>
    </div>
  );
}
