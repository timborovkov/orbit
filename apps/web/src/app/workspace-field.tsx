'use client';

import { useState, useSyncExternalStore } from 'react';

import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const subscribe = () => () => undefined;
const clientReady = () => true;
const serverReady = () => false;

const controlClassName = 'm-0';

export function WorkspaceField({
  id,
  name,
  label,
  initialValue = '',
  multiline = false,
  required = false,
  maxLength = 12000,
  rows = 3,
  description,
  error,
}: {
  id: string;
  name: string;
  label: string;
  initialValue?: string;
  multiline?: boolean;
  required?: boolean;
  maxLength?: number;
  rows?: number;
  description?: string;
  error?: string;
}) {
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [value, setValue] = useState(initialValue);
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, descriptionId].filter(Boolean).join(' ') || undefined;
  const props = {
    id,
    name,
    value,
    required,
    maxLength,
    readOnly: !hydrated,
    'aria-invalid': Boolean(error) || undefined,
    'aria-describedby': describedBy,
    className: controlClassName,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setValue(event.target.value);
    },
  };
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {required && (
          <span className="field-required-mark" aria-label="required">
            {' '}
            *
          </span>
        )}
      </FieldLabel>
      {multiline ? <Textarea {...props} rows={rows} /> : <Input {...props} />}
      {description ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </Field>
  );
}

export function WorkspaceSelect({
  id,
  name,
  label,
  initialValue,
  options,
  description,
  error,
}: {
  id: string;
  name: string;
  label: string;
  initialValue: string;
  options: { value: string; label: string }[];
  description?: string;
  error?: string;
}) {
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [value, setValue] = useState(initialValue);
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, descriptionId].filter(Boolean).join(' ') || undefined;
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        disabled={!hydrated}
        id={id}
        name={name}
        aria-label={label}
        value={value}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy}
        className={cn(
          controlClassName,
          'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          'disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
          'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        )}
        onChange={(event) => {
          const selected = event.currentTarget.value;
          setValue(selected);
          // Preserve the chosen replay version through the form's native reset.
          for (const option of event.currentTarget.options) {
            option.defaultSelected = option.value === selected;
          }
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {description ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </Field>
  );
}
