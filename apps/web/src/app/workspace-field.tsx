'use client';

import { useState, useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;
const clientReady = () => true;
const serverReady = () => false;

export function WorkspaceField({
  id,
  name,
  label,
  initialValue = '',
  multiline = false,
  required = false,
  maxLength = 12000,
  rows = 3,
}: {
  id: string;
  name: string;
  label: string;
  initialValue?: string;
  multiline?: boolean;
  required?: boolean;
  maxLength?: number;
  rows?: number;
}) {
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [value, setValue] = useState(initialValue);
  const props = {
    id,
    name,
    value,
    required,
    maxLength,
    readOnly: !hydrated,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setValue(event.target.value);
    },
  };
  return (
    <div>
      <label htmlFor={id}>
        {label}
        {required && (
          <span className="field-required-mark" aria-label="required">
            {' '}
            *
          </span>
        )}
      </label>
      {multiline ? <textarea {...props} rows={rows} /> : <input {...props} />}
    </div>
  );
}

export function WorkspaceSelect({
  id,
  name,
  label,
  initialValue,
  options,
}: {
  id: string;
  name: string;
  label: string;
  initialValue: string;
  options: { value: string; label: string }[];
}) {
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [value, setValue] = useState(initialValue);
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <select
        disabled={!hydrated}
        id={id}
        name={name}
        value={value}
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
    </div>
  );
}
