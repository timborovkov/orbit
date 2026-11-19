'use client';

import { useRef, useState, useTransition } from 'react';
import { Plus, X } from 'lucide-react';

import { createAgent } from '@/actions/agents';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

const empty = {
  name: '',
  mission: '',
  templateId: 'blank',
  error: '',
  errors: {} as { name?: string[]; mission?: string[] },
};
export function CreateAgent({
  templates,
}: {
  templates: { id: string; title: string; mission: string }[];
}) {
  const [open, setOpen] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const missionInput = useRef<HTMLTextAreaElement>(null);
  const [form, setForm] = useState(empty);
  const [pending, startTransition] = useTransition();
  function close() {
    setOpen(false);
  }
  const nameInvalid = Boolean(form.errors.name?.length);
  const missionInvalid = Boolean(form.errors.mission?.length);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (pending) return;
        if (nextOpen) setForm(empty);
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus size={16} aria-hidden="true" />
          Create agent
        </Button>
      </DialogTrigger>
      <DialogContent
        className="create-dialog"
        showCloseButton={false}
        onPointerDownOutside={(event) => {
          event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          nameInput.current?.focus();
        }}
      >
        <div className="dialog-heading">
          <DialogTitle>Create agent</DialogTitle>
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
        <DialogDescription>
          Your agent starts in shadow mode, with external writes suppressed. You can set its
          OpenRouter key under Access.
        </DialogDescription>
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
                <input type="hidden" name="templateId" value={form.templateId} />
                <Select
                  value={form.templateId}
                  disabled={pending}
                  onValueChange={(value) => {
                    const template = templates.find((item) => item.id === value);
                    setForm((previous) => ({
                      ...previous,
                      templateId: value,
                      mission: template?.mission ?? '',
                    }));
                  }}
                >
                  <SelectTrigger id="agent-template" className="w-full" aria-label="Template">
                    <SelectValue placeholder="Choose a template" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>Choosing a template fills in the mission.</FieldDescription>
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
      </DialogContent>
    </Dialog>
  );
}
