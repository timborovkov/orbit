'use client';

import { useId, useRef, useState, useTransition } from 'react';

import { saveCredential } from '@/actions/workspace';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';

export function AccessCredentialForms({
  agentId,
  hasAgentCredential,
  credentialAction = saveCredential,
  placeholder = 'Enter an OpenRouter key for this agent',
}: {
  agentId: string;
  hasAgentCredential: boolean;
  credentialAction?: (form: FormData) => Promise<{ error?: string; message?: string }>;
  placeholder?: string;
}) {
  const inputId = useId();
  const saveForm = useRef<HTMLFormElement>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();

  function submit(form: FormData) {
    startTransition(async () => {
      setError('');
      setMessage('');
      try {
        const result = await credentialAction(form);
        if (result.error) {
          setError(result.error);
          return;
        }
        if (result.message) setMessage(result.message);
        if (form.get('revoke') !== 'true') saveForm.current?.reset();
      } catch {
        setError(
          'Unable to save. Check your connection and try again. Re-enter the API key if saving credentials.',
        );
      }
    });
  }

  return (
    <div className="access-credential-forms">
      <form ref={saveForm} action={submit} className="workspace-form">
        <fieldset disabled={pending}>
          <input type="hidden" name="agentId" value={agentId} />
          <Field>
            <FieldLabel htmlFor={inputId}>Agent API key</FieldLabel>
            <Input
              id={inputId}
              type="password"
              name="credential"
              autoComplete="new-password"
              required
              maxLength={512}
              placeholder={placeholder}
              className="m-0"
            />
            <FieldDescription>
              Stored encrypted for this agent only. The value is never shown again after you save.
            </FieldDescription>
          </Field>
        </fieldset>
        <div className="workspace-form-footer">
          <SubmitButton disabled={pending} pendingLabel="Working…">
            {pending ? 'Working…' : hasAgentCredential ? 'Replace agent key' : 'Save agent key'}
          </SubmitButton>
        </div>
      </form>
      {hasAgentCredential && (
        <form action={submit} className="workspace-form">
          <fieldset disabled={pending}>
            <input type="hidden" name="agentId" value={agentId} />
            <input type="hidden" name="revoke" value="true" />
            <FieldDescription>
              Removing the agent key falls back to the environment default when one is configured.
            </FieldDescription>
          </fieldset>
          <div className="workspace-form-footer">
            <SubmitButton variant="destructive" disabled={pending} pendingLabel="Working…">
              {pending ? 'Working…' : 'Remove agent key'}
            </SubmitButton>
          </div>
        </form>
      )}
      {error ? <FieldError className="form-error">{error}</FieldError> : null}
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
