'use client';

import { type ComponentProps, useState } from 'react';

import { WorkspaceForm } from '@/app/workspace-form';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';

export function ActionRequirementsForm({
  agentId,
  idPrefix,
  options,
  selected,
  action,
  label,
  legend,
  description,
}: {
  agentId: string;
  idPrefix: string;
  options: { value: string; label: string }[];
  selected: string[];
  action: ComponentProps<typeof WorkspaceForm>['action'];
  label: string;
  legend: string;
  description: string;
}) {
  const [checked, setChecked] = useState(() => new Set(selected));

  return (
    <WorkspaceForm action={action} label={label}>
      <input type="hidden" name="agentId" value={agentId} />
      {options
        .filter(({ value }) => checked.has(value))
        .map(({ value }) => (
          <input key={value} type="hidden" name="tool" value={value} />
        ))}
      <FieldSet>
        <FieldLegend variant="label">{legend}</FieldLegend>
        <FieldDescription>{description}</FieldDescription>
        <FieldGroup className="approval-tool-list gap-0" data-slot="checkbox-group">
          {options.map(({ value, label }) => {
            const id = `${idPrefix}-${value}`;
            return (
              <Field key={value} orientation="horizontal" className="approval-tool-row">
                <FieldLabel htmlFor={id} className="font-medium">
                  {label}
                </FieldLabel>
                <Checkbox
                  id={id}
                  checked={checked.has(value)}
                  onCheckedChange={(next) => {
                    setChecked((previous) => {
                      const selected = new Set(previous);
                      if (next === true) selected.add(value);
                      else selected.delete(value);
                      return selected;
                    });
                  }}
                />
              </Field>
            );
          })}
        </FieldGroup>
      </FieldSet>
    </WorkspaceForm>
  );
}
