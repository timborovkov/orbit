'use client';

import { useId, useState, useTransition } from 'react';

import { saveCaseFromEmailMessage, saveCaseFromRun } from '@/actions/evaluation';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';

export function SaveRunCaseForm({
  agentId,
  runId,
  defaultTitle,
}: {
  agentId: string;
  runId: string;
  defaultTitle: string;
}) {
  const formId = useId();
  const [state, setState] = useState<{ error?: string; message?: string }>({});
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="save-evaluation-case"
      action={(data) => {
        startTransition(async () => {
          setState({});
          const result = await saveCaseFromRun(data);
          if ('error' in result && result.error) {
            setState({ error: result.error });
            return;
          }
          setState({ message: 'Saved as evaluation case.' });
        });
      }}
    >
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="runId" value={runId} />
      <Field data-invalid={state.error ? true : undefined}>
        <FieldLabel htmlFor={`${formId}-title`}>Case title</FieldLabel>
        <Input
          id={`${formId}-title`}
          name="title"
          defaultValue={defaultTitle}
          maxLength={200}
          required
        />
        {state.error && <FieldError>{state.error}</FieldError>}
      </Field>
      {state.message && <p role="status">{state.message}</p>}
      <SubmitButton disabled={pending} pendingLabel="Saving…" size="sm" variant="outline">
        {pending ? 'Saving…' : 'Save as case'}
      </SubmitButton>
    </form>
  );
}

export function SaveEmailCaseForm({
  agentId,
  messageId,
  input,
  defaultTitle,
}: {
  agentId: string;
  messageId: string;
  input: string;
  defaultTitle: string;
}) {
  const formId = useId();
  const [state, setState] = useState<{ error?: string; message?: string }>({});
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="save-evaluation-case"
      action={(data) => {
        startTransition(async () => {
          setState({});
          const result = await saveCaseFromEmailMessage(data);
          if ('error' in result && result.error) {
            setState({ error: result.error });
            return;
          }
          setState({ message: 'Saved as evaluation case.' });
        });
      }}
    >
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="messageId" value={messageId} />
      <input type="hidden" name="input" value={input} />
      <Field data-invalid={state.error ? true : undefined}>
        <FieldLabel htmlFor={`${formId}-title`}>Case title</FieldLabel>
        <Input
          id={`${formId}-title`}
          name="title"
          defaultValue={defaultTitle}
          maxLength={200}
          required
        />
        {state.error && <FieldError>{state.error}</FieldError>}
      </Field>
      {state.message && <p role="status">{state.message}</p>}
      <SubmitButton disabled={pending} pendingLabel="Saving…" size="sm" variant="outline">
        {pending ? 'Saving…' : 'Save as case'}
      </SubmitButton>
    </form>
  );
}
