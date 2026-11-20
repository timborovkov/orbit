'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { reviewEmailReply } from '@/actions/email';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function EmailDraftReview({
  agentId,
  intentId,
  initialDraft,
}: {
  agentId: string;
  intentId: string;
  initialDraft: string;
}) {
  const draftId = useId();
  const router = useRouter();
  const [draft, setDraft] = useState(initialDraft);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function review(decision: 'approved' | 'rejected') {
    setError(null);
    startTransition(async () => {
      const result = await reviewEmailReply({
        agentId,
        intentId,
        decision,
        draft: decision === 'approved' ? draft : undefined,
      });
      if ('error' in result) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="email-draft-review">
      <label className="email-draft-label" htmlFor={draftId}>
        Reply draft
      </label>
      <Textarea
        id={draftId}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        rows={6}
        disabled={pending}
        className="email-draft-editor"
      />
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="email-draft-actions">
        <Button
          type="button"
          disabled={pending || !draft.trim()}
          onClick={() => {
            review('approved');
          }}
        >
          {pending ? 'Saving…' : 'Approve & queue'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => {
            review('rejected');
          }}
        >
          Reject
        </Button>
      </div>
      <p className="muted">
        Sending requires Live lifecycle, released global pause, and an enabled mailbox. Destination
        and threading come from the inbound message.
      </p>
    </div>
  );
}
