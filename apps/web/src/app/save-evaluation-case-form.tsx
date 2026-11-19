'use client';

import { useState, useTransition } from 'react';

import { saveCaseFromEmailMessage, saveCaseFromPlaygroundRun } from '@/actions/evaluation';
import { SubmitButton } from '@/components/ui/submit-button';

export function SavePlaygroundCaseForm({
  agentId,
  runId,
  input,
  recipients,
  defaultTitle,
}: {
  agentId: string;
  runId: string;
  input: string;
  recipients: string[];
  defaultTitle: string;
}) {
  const [state, setState] = useState<{ error?: string; message?: string }>({});
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="save-evaluation-case"
      action={(data) => {
        startTransition(async () => {
          setState({});
          const result = await saveCaseFromPlaygroundRun(data);
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
      <input type="hidden" name="input" value={input} />
      <input type="hidden" name="recipients" value={JSON.stringify(recipients)} />
      <label className="workspace-field">
        <span>Case title</span>
        <input
          className="library-field-control"
          name="title"
          defaultValue={defaultTitle}
          maxLength={200}
          required
        />
      </label>
      {state.error && (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      )}
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
      <label className="workspace-field">
        <span>Case title</span>
        <input
          className="library-field-control"
          name="title"
          defaultValue={defaultTitle}
          maxLength={200}
          required
        />
      </label>
      {state.error && (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      )}
      {state.message && <p role="status">{state.message}</p>}
      <SubmitButton disabled={pending} pendingLabel="Saving…" size="sm" variant="outline">
        {pending ? 'Saving…' : 'Save as case'}
      </SubmitButton>
    </form>
  );
}
