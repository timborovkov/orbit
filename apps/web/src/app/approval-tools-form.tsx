'use client';

import { useRef, useState } from 'react';

import { saveApprovalTools } from '@/actions/policy';
import { WorkspaceForm } from '@/app/workspace-form';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
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
  approvalExpiresAfterHours,
  approvalOnReject,
  approvalSpendCents,
}: {
  agentId: string;
  approvalTools: string[];
  approvalExpiresAfterHours: number | null;
  approvalOnReject: 'continue' | 'end';
  approvalSpendCents: number | null;
}) {
  const tools = proposalTypes.filter((tool) => tool !== 'introduce' && tool !== 'escalate');
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const initial = new Set(approvalTools);
    return Object.fromEntries(tools.map((tool) => [tool, initial.has(tool)]));
  });
  const spendDollars = approvalSpendCents === null ? '' : String(approvalSpendCents / 100);
  const onRejectRef = useRef<HTMLInputElement>(null);

  return (
    <WorkspaceForm action={saveApprovalTools} label="Save approval requirements">
      <input type="hidden" name="agentId" value={agentId} />
      <input
        ref={onRejectRef}
        type="hidden"
        name="approvalOnReject"
        defaultValue={approvalOnReject}
      />
      {tools.map((tool) =>
        checked[tool] ? (
          <input key={`hidden-${tool}`} type="hidden" name="tool" value={tool} />
        ) : null,
      )}
      <FieldSet>
        <FieldLegend variant="label">Actions requiring approval</FieldLegend>
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
                <Switch
                  id={id}
                  checked={checked[tool]}
                  onCheckedChange={(value) => {
                    setChecked((previous) => ({ ...previous, [tool]: value }));
                  }}
                  aria-label={actionLabels[tool]}
                />
              </Field>
            );
          })}
        </FieldGroup>
      </FieldSet>

      <FieldGroup className="gap-5 pt-2">
        <Field>
          <FieldLabel htmlFor="approval-spend">Spend threshold</FieldLabel>
          <InputGroup className="approval-spend-field max-w-[240px]">
            <InputGroupAddon align="inline-start" className="text-muted-foreground">
              <InputGroupText aria-hidden="true">$</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              id="approval-spend"
              name="approvalSpendDollars"
              type="number"
              inputMode="decimal"
              min={0.01}
              step={0.01}
              defaultValue={spendDollars}
              placeholder="Optional"
              className="approval-spend-input border-0 bg-transparent shadow-none focus-visible:border-0 focus-visible:ring-0"
            />
          </InputGroup>
          <FieldDescription>
            When set, write actions need approval once today’s recorded spend reaches this amount.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="approval-expiry">Auto-reject after (hours)</FieldLabel>
          <Input
            id="approval-expiry"
            name="approvalExpiresAfterHours"
            type="number"
            inputMode="numeric"
            min={1}
            max={720}
            defaultValue={approvalExpiresAfterHours ?? undefined}
            placeholder="Optional"
            className="max-w-[240px] m-0"
          />
          <FieldDescription>Leave blank to keep pending items until reviewed.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="approval-on-reject">When a proposal is rejected</FieldLabel>
          <Select
            defaultValue={approvalOnReject}
            onValueChange={(value) => {
              if (onRejectRef.current && (value === 'continue' || value === 'end')) {
                onRejectRef.current.value = value;
              }
            }}
          >
            <SelectTrigger id="approval-on-reject" className="w-full max-w-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="continue">Continue the run with the decline recorded</SelectItem>
              <SelectItem value="end">End the run</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>
    </WorkspaceForm>
  );
}
