'use client';

import Link from 'next/link';

import { ArrowUp, ShieldCheck } from 'lucide-react';

import { PlaygroundBlockNotice } from '@/app/playground-block-notice';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function ComposerActions({
  watching,
  canSubmit,
  onStopWatching,
}: {
  watching: boolean;
  canSubmit: boolean;
  onStopWatching: () => void;
}) {
  if (watching) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={onStopWatching}>
        Stop watching
      </Button>
    );
  }
  return (
    <PromptInputSubmit disabled={!canSubmit} size="icon-sm" className="playground-submit">
      <ArrowUp className="size-4" aria-hidden="true" />
    </PromptInputSubmit>
  );
}

function ComposerNotices({
  blockedNotice,
  canRetry,
  onRetry,
  error,
  runId,
  stoppedWatching,
  streamError,
}: {
  blockedNotice: string | null;
  canRetry: boolean;
  onRetry: () => void;
  error: string | null | undefined;
  runId: string | null;
  stoppedWatching: boolean;
  streamError?: string;
}) {
  return (
    <>
      {blockedNotice ? (
        <PlaygroundBlockNotice notice={blockedNotice} canRetry={canRetry} onRetry={onRetry} />
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {runId && (stoppedWatching || streamError) ? (
        <div className="playground-watch-notice">
          {stoppedWatching ? (
            <span role="status">Stopped watching. Inference may continue.</span>
          ) : null}
          <Link href={`?run=${runId}`} scroll={false} prefetch={false}>
            Open run in History
          </Link>
        </div>
      ) : null}
    </>
  );
}

export function PlaygroundComposer({
  canSimulate,
  busy,
  runId,
  stoppedWatching,
  draft,
  onDraftChange,
  streamError,
  formError,
  blockedNotice,
  onSubmit,
  onRetry,
  onAttachment,
  onStopWatching,
}: {
  canSimulate: boolean;
  busy: boolean;
  runId: string | null;
  stoppedWatching: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  streamError?: string;
  formError: string | null;
  blockedNotice: string | null;
  onSubmit: (input: string) => void;
  onRetry: () => void;
  onAttachment: () => void;
  onStopWatching: () => void;
}) {
  const error = formError ?? (blockedNotice ? null : streamError);

  return (
    <div className="playground-composer">
      <PromptInput
        className={cn('playground-prompt', !canSimulate && 'is-disabled')}
        onAttachment={onAttachment}
        onSubmit={(text) => {
          onDraftChange(text);
          onSubmit(text);
        }}
      >
        <PromptInputTextarea
          aria-label="Post or question"
          placeholder="Paste a post or question…"
          disabled={!canSimulate || busy}
          maxLength={16000}
          value={draft}
          onChange={(event) => {
            onDraftChange(event.target.value);
          }}
          className="resize-none border-0 bg-transparent shadow-none focus-visible:border-0 focus-visible:ring-0"
        />
        <PromptInputFooter>
          <PromptInputTools>
            <p className="simulation-note">
              <ShieldCheck size={15} aria-hidden="true" />
              <span>
                Nothing is posted or sent. Model usage can incur charges. Save your configuration
                before testing.
              </span>
            </p>
          </PromptInputTools>
          <ComposerActions
            watching={Boolean(busy && runId)}
            canSubmit={canSimulate && !busy && Boolean(draft.trim())}
            onStopWatching={onStopWatching}
          />
        </PromptInputFooter>
      </PromptInput>
      <ComposerNotices
        blockedNotice={blockedNotice}
        canRetry={canSimulate && !busy && Boolean(draft.trim())}
        onRetry={onRetry}
        error={error}
        runId={runId}
        stoppedWatching={stoppedWatching}
        streamError={streamError}
      />
    </div>
  );
}
