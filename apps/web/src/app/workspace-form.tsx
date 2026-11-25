'use client';

import { useRef, useState, useTransition } from 'react';

import { SubmitButton } from '@/components/ui/submit-button';
import { useToast } from '@/components/ui/toast';

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
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const { toast, dismiss } = useToast();
  const toastId = useRef<number>(null);

  function markDirty() {
    setDirty(true);
    if (toastId.current !== null) {
      dismiss(toastId.current);
      toastId.current = null;
    }
  }

  return (
    <form
      action={(data) => {
        if (disabled) return;
        startTransition(async () => {
          setError(undefined);
          try {
            const result = await action(data);
            if (result.error) {
              setError(result.error);
              toastId.current = toast(result.error, { variant: 'error' });
              return;
            }
            setDirty(false);
            toastId.current = toast(result.message ?? 'Saved');
          } catch {
            const message =
              'Unable to save. Check your connection and try again. Re-enter the API key if saving credentials.';
            setError(message);
            toastId.current = toast(message, { variant: 'error' });
          }
        });
      }}
      onInput={markDirty}
      onChange={markDirty}
      className="workspace-form"
    >
      <fieldset disabled={pending || disabled}>{children}</fieldset>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
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
