'use client';

import { useRef, useState, useTransition } from 'react';

import { saveCredential } from '@/actions/workspace';
import { SubmitButton } from '@/components/ui/submit-button';

export function AccessCredentialForms({
  agentId,
  hasAgentCredential,
}: {
  agentId: string;
  hasAgentCredential: boolean;
}) {
  const saveForm = useRef<HTMLFormElement>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();

  function submit(form: FormData) {
    startTransition(async () => {
      setError('');
      setMessage('');
      try {
        const result = await saveCredential(form);
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
          <label htmlFor="credential-key">Agent API key</label>
          <input
            id="credential-key"
            type="password"
            name="credential"
            autoComplete="new-password"
            required
            maxLength={512}
            placeholder="Enter an OpenRouter key for this agent"
          />
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
          </fieldset>
          <div className="workspace-form-footer">
            <SubmitButton disabled={pending} pendingLabel="Working…">
              {pending ? 'Working…' : 'Remove agent key'}
            </SubmitButton>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
