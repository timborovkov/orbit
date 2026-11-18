'use client';

import { useRef, useState, useTransition } from 'react';
import { Plus, X } from 'lucide-react';

import { createAgent } from '@/actions/agents';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const empty = {
  name: '',
  mission: '',
  error: '',
  errors: {} as { name?: string[]; mission?: string[] },
};
export function CreateAgent({
  templates,
}: {
  templates: { id: string; title: string; mission: string }[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const missionInput = useRef<HTMLTextAreaElement>(null);
  const [form, setForm] = useState(empty);
  const [pending, startTransition] = useTransition();
  function close() {
    dialog.current?.close();
  }
  const nameInvalid = Boolean(form.errors.name?.length);
  const missionInvalid = Boolean(form.errors.mission?.length);
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
          Define an identity and a mission. New agents start in shadow mode with external writes
          suppressed, and can use the server OpenRouter key until you add an agent-specific override
          under Access.
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
            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel htmlFor="agent-template">Template</FieldLabel>
                <select
                  id="agent-template"
                  name="templateId"
                  aria-label="Template"
                  defaultValue="blank"
                  disabled={pending}
                  className="m-0 h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30"
                  onChange={(event) => {
                    const template = templates.find((item) => item.id === event.target.value);
                    setForm((previous) => ({ ...previous, mission: template?.mission ?? '' }));
                  }}
                >
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.title}
                    </option>
                  ))}
                </select>
                <FieldDescription>
                  Choosing a template fills the mission. Existing agents are never changed.
                </FieldDescription>
              </Field>
              <Field data-invalid={nameInvalid || undefined}>
                <FieldLabel htmlFor="agent-name">
                  Name <span className="field-required">Required</span>
                </FieldLabel>
                <Input
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
                  aria-invalid={nameInvalid || undefined}
                  aria-describedby={nameInvalid ? 'name-error' : undefined}
                  className="m-0"
                />
                {nameInvalid ? (
                  <FieldError id="name-error">Enter a name with 1–80 characters.</FieldError>
                ) : null}
              </Field>
              <Field data-invalid={missionInvalid || undefined}>
                <FieldLabel htmlFor="agent-mission">
                  Mission <span className="field-required">Required</span>
                </FieldLabel>
                <Textarea
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
                  rows={5}
                  aria-invalid={missionInvalid || undefined}
                  aria-describedby={missionInvalid ? 'mission-error' : 'mission-hint'}
                  className="m-0 min-h-28"
                />
                {missionInvalid ? (
                  <FieldError id="mission-error">
                    Enter a mission with 1–2,000 characters.
                  </FieldError>
                ) : (
                  <FieldDescription id="mission-hint">
                    Describe the outcome this agent should work towards.
                  </FieldDescription>
                )}
              </Field>
            </FieldGroup>
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
              {pending ? 'Creating…' : 'Create shadow agent'}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
