'use client';

import { useState } from 'react';

import { saveApprovalTools } from '@/actions/policy';
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
import { proposalTypes } from '@/lib/policy/scopes';

const actionLabels = {
  reply: 'Reply',
  like: 'Like',
  repost: 'Repost',
  follow: 'Follow',
  bookmark: 'Bookmark',
} as Record<string, string>;

const actionHints = {
  reply: 'Draft replies wait for an administrator before any send path.',
  like: 'Like proposals stay pending until approved.',
  repost: 'Repost proposals stay pending until approved.',
  follow: 'Follow proposals stay pending until approved.',
  bookmark: 'Bookmark proposals stay pending until approved.',
} as Record<string, string>;

export function ApprovalToolsForm({
  agentId,
  approvalTools,
}: {
  agentId: string;
  approvalTools: string[];
}) {
  const tools = proposalTypes.filter((tool) => tool !== 'introduce' && tool !== 'escalate');
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const initial = new Set(approvalTools);
    return Object.fromEntries(tools.map((tool) => [tool, initial.has(tool)]));
  });

  return (
    <WorkspaceForm action={saveApprovalTools} label="Save approval requirements">
      <input type="hidden" name="agentId" value={agentId} />
      {tools.map((tool) =>
        checked[tool] ? (
          <input key={`hidden-${tool}`} type="hidden" name="tool" value={tool} />
        ) : null,
      )}
      <FieldSet>
        <FieldLegend variant="label">Other actions requiring approval</FieldLegend>
        <FieldDescription>
          Select actions that must wait for an administrator decision before they can proceed.
          Introductions and escalations always require approval.
        </FieldDescription>
        <FieldGroup className="approval-tool-list gap-0" data-slot="checkbox-group">
          {tools.map((tool) => {
            const id = `approval-tool-${tool}`;
            return (
              <Field key={tool} orientation="horizontal" className="approval-tool-row">
                <div className="approval-tool-copy">
                  <FieldLabel htmlFor={id} className="font-medium">
                    {actionLabels[tool]}
                  </FieldLabel>
                  <FieldDescription className="text-pretty">{actionHints[tool]}</FieldDescription>
                </div>
                <Checkbox
                  id={id}
                  checked={checked[tool]}
                  onCheckedChange={(value) => {
                    setChecked((previous) => ({ ...previous, [tool]: value === true }));
                  }}
                  aria-label={actionLabels[tool]}
                />
              </Field>
            );
          })}
        </FieldGroup>
      </FieldSet>
    </WorkspaceForm>
  );
}
