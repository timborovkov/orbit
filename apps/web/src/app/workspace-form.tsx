'use client';

import { useState, useTransition } from 'react';

import { SubmitButton } from '@/components/ui/submit-button';

export function WorkspaceForm({
  action,
  children,
  label,
  saveState = false,
  disabled = false,
}: {
  action: (form: FormData) => Promise<{ error?: string; message?: string }>;
  children: React.ReactNode;
  label: string;
  saveState?: boolean;
  disabled?: boolean;
}) {
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<{ error?: string; message?: string }>({});
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={(data) => {
        if (disabled) return;
        startTransition(async () => {
          setState({});
          try {
            const result = await action(data);
            setState(result);
            if (!result.error) setDirty(false);
          } catch {
            setState({
              error:
                'Unable to save. Check your connection and try again. Re-enter the API key if saving credentials.',
            });
          }
        });
      }}
      onChange={() => {
        setDirty(true);
      }}
      className="workspace-form"
    >
      <fieldset disabled={pending || disabled}>{children}</fieldset>
      {state.error && (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      )}
      {state.message && <p role="status">{state.message}</p>}
      <div className="workspace-form-footer">
        {saveState && (
          <span className="save-status">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
        )}
        <SubmitButton disabled={pending || disabled} pendingLabel="Working…">
          {pending ? 'Working…' : label}
        </SubmitButton>
      </div>
    </form>
  );
}
