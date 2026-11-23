'use client';

import { useActionState } from 'react';

import { importWebResearchPage, requestWebCrawlCancellation } from '@/actions/research';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SubmitButton } from '@/components/ui/submit-button';

type FormStatus = { error?: string; message?: string };

export function ResearchActivityAction({
  agentId,
  target,
}: {
  agentId: string;
  target: { crawlId: string } | { citationId: string; libraries: { id: string; name: string }[] };
}) {
  const cancel = 'crawlId' in target;
  const [state, action, pending] = useActionState(async (_state: FormStatus, form: FormData) => {
    try {
      return await (cancel ? requestWebCrawlCancellation(form) : importWebResearchPage(form));
    } catch {
      return { error: 'The request could not be saved. Try again.' };
    }
  }, {});
  return (
    <form action={action} className="research-activity-form">
      <input type="hidden" name="agentId" value={agentId} />
      {cancel ? (
        <input type="hidden" name="crawlId" value={target.crawlId} />
      ) : (
        <Field>
          <input type="hidden" name="citationId" value={target.citationId} />
          <FieldLabel htmlFor={'library-' + target.citationId}>Shared library</FieldLabel>
          <Select name="libraryId" required>
            <SelectTrigger id={'library-' + target.citationId}>
              <SelectValue placeholder="Choose a library" />
            </SelectTrigger>
            <SelectContent>
              {target.libraries.map(({ id, name }) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      <div>
        <SubmitButton
          disabled={pending}
          pendingLabel={cancel ? 'Cancelling…' : 'Importing…'}
          size="sm"
          variant={cancel ? 'destructive' : 'outline'}
        >
          {cancel ? 'Cancel crawl' : 'Import into shared library'}
        </SubmitButton>
      </div>
      {state.error && <FieldError>{state.error}</FieldError>}
      {state.message && <p role="status">{state.message}</p>}
    </form>
  );
}
