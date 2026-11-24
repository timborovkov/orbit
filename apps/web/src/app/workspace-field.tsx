'use client';

import { useState } from 'react';

import { useHydrated } from '@/app/use-hydrated';
import { MarkdownEditor } from '@/components/markdown-editor';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function WorkspaceField({
  id,
  name,
  label,
  initialValue = '',
  required = false,
  maxLength = 12000,
  markdown = false,
  compactMarkdown = false,
  description,
  error,
}: {
  id: string;
  name: string;
  label: string;
  initialValue?: string;
  required?: boolean;
  maxLength?: number;
  markdown?: boolean;
  compactMarkdown?: boolean;
  description?: string;
  error?: string;
}) {
  const hydrated = useHydrated();
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
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setValue(event.target.value);
    },
  };
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {required && (
          <span className="field-required-mark" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </FieldLabel>
      {markdown ? (
        <MarkdownEditor
          id={id}
          name={name}
          value={value}
          onValueChange={setValue}
          compact={compactMarkdown}
          readOnly={!hydrated}
          required={required}
          maxLength={maxLength}
          aria-invalid={props['aria-invalid']}
          aria-describedby={describedBy}
        />
      ) : (
        <Input {...props} />
      )}
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
  const hydrated = useHydrated();
  const [value, setValue] = useState(initialValue);
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, descriptionId].filter(Boolean).join(' ') || undefined;
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input type="hidden" name={name} value={value} />
      <Select value={value} onValueChange={setValue} disabled={!hydrated}>
        <SelectTrigger
          id={id}
          className="w-full min-w-0"
          aria-label={label}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy}
        >
          <SelectValue placeholder="Choose an option" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </Field>
  );
}
