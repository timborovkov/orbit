'use client';

import { useState } from 'react';

import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

type SeedRow = { id: string; value: string };

function newRow(value = ''): SeedRow {
  return { id: crypto.randomUUID(), value };
}

export function SeedListEditor({
  name,
  label,
  initialValues,
  placeholder,
  max = 20,
  maxLength = 500,
}: {
  name: string;
  label: string;
  initialValues: string[];
  placeholder: string;
  max?: number;
  maxLength?: number;
}) {
  const [rows, setRows] = useState<SeedRow[]>(() =>
    (initialValues.length ? initialValues : ['']).map((value) => newRow(value)),
  );

  return (
    <div className="seed-list-editor" role="group" aria-label={label}>
      {rows.map((row, index) => (
        <div key={row.id} className="seed-list-row">
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor={`${name}-${row.id}`} className={index > 0 ? 'sr-only' : undefined}>
              {label}
            </FieldLabel>
            <Input
              id={`${name}-${row.id}`}
              name={name}
              value={row.value}
              maxLength={maxLength}
              placeholder={placeholder}
              onChange={(event) => {
                const value = event.target.value;
                setRows((current) =>
                  current.map((entry) => (entry.id === row.id ? { ...entry, value } : entry)),
                );
              }}
            />
          </Field>
          {rows.length > 1 && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
              onClick={() => {
                setRows((current) => {
                  const next = current.filter((entry) => entry.id !== row.id);
                  return next.length ? next : [newRow()];
                });
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
            </Button>
          )}
        </div>
      ))}
      {rows.length < max && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setRows((current) => [...current, newRow()]);
          }}
        >
          <Plus size={14} aria-hidden="true" />
          Add
        </Button>
      )}
    </div>
  );
}
