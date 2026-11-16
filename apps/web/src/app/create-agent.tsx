'use client';
import { Plus, X } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';

import { Button } from '../components/ui/button';

import { createAgent } from './actions';

const empty = {
  name: '',
  mission: '',
  error: '',
  errors: {} as { name?: string[]; mission?: string[] },
};
export function CreateAgent() {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const missionInput = useRef<HTMLTextAreaElement>(null);
  const [form, setForm] = useState(empty);
  const [pending, startTransition] = useTransition();
  function close() {
    dialog.current?.close();
  }
  return (
    <>
      <Button
        onClick={() => {
          setForm(empty);
          dialog.current?.showModal();
          nameInput.current?.focus();
        }}
      >
        <Plus size={16} aria-hidden="true" />
        Create agent
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby="create-title"
        aria-describedby="create-description"
        className="create-dialog"
        onCancel={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <div className="dialog-heading">
          <h2 id="create-title">Create agent</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close dialog"
            disabled={pending}
            onClick={close}
          >
            <X size={18} aria-hidden="true" />
          </Button>
        </div>
        <p id="create-description" className="muted">
          Define an identity and a mission. New agents start paused in shadow mode.
        </p>
        <form
          action={(data) => {
            startTransition(async () => {
              setForm((previous) => ({ ...previous, error: '', errors: {} }));
              try {
                const result = await createAgent(data);
                if (result.ok) {
                  close();
                  setForm(empty);
                } else {
                  setForm((previous) => ({ ...previous, errors: result.errors }));
                  if (result.errors.name?.length) nameInput.current?.focus();
                  else missionInput.current?.focus();
                }
              } catch {
                setForm((previous) => ({
                  ...previous,
                  error:
                    'Unable to create agent. Your entries are kept. Check your connection and try again.',
                }));
              }
            });
          }}
        >
          <fieldset aria-disabled={pending}>
            <label htmlFor="agent-name">
              Name <span className="field-required">Required</span>
            </label>
            <input
              ref={nameInput}
              id="agent-name"
              name="name"
              value={form.name}
              onChange={(e) => {
                setForm((previous) => ({ ...previous, name: e.target.value }));
              }}
              readOnly={pending}
              maxLength={80}
              required
              autoComplete="off"
              aria-invalid={Boolean(form.errors.name?.length)}
              aria-describedby={form.errors.name?.length ? 'name-error' : undefined}
            />
            {form.errors.name?.length ? (
              <p id="name-error" className="field-error">
                Enter a name with 1–80 characters.
              </p>
            ) : null}
            <label htmlFor="agent-mission">
              Mission <span className="field-required">Required</span>
            </label>
            <textarea
              ref={missionInput}
              id="agent-mission"
              name="mission"
              value={form.mission}
              onChange={(e) => {
                setForm((previous) => ({ ...previous, mission: e.target.value }));
              }}
              readOnly={pending}
              maxLength={2000}
              required
              aria-invalid={Boolean(form.errors.mission?.length)}
              aria-describedby={form.errors.mission?.length ? 'mission-error' : 'mission-hint'}
            />
            {form.errors.mission?.length ? (
              <p id="mission-error" className="field-error">
                Enter a mission with 1–2,000 characters.
              </p>
            ) : null}
            <p id="mission-hint" className="field-hint">
              Describe the outcome this agent should work towards.
            </p>
          </fieldset>
          {form.error ? (
            <p role="alert" className="form-error">
              {form.error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create paused agent'}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
