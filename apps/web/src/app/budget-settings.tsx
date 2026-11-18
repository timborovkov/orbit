'use client';

import { useState } from 'react';

import { saveAgentBudgets } from '@/actions/lifecycle';
import { WorkspaceForm } from '@/app/workspace-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { budgetFields, type AgentBudgets } from '@/lib/budgets';
import { cn } from '@/lib/utils';

export interface BudgetUsageView {
  day: { spendMicros: bigint; requests: number; outboundActions: number };
  month: { spendMicros: bigint; requests: number; outboundActions: number };
  activeRuns: number;
}

function formatSpendCents(micros: bigint): string {
  const cents = Number(micros) / 10_000;
  return Number.isInteger(cents) ? String(cents) : cents.toFixed(2);
}

function usageLine(
  field: (typeof budgetFields)[number]['key'],
  budgets: AgentBudgets,
  usage: BudgetUsageView,
): string | null {
  switch (field) {
    case 'dailySpendCents':
      return budgets.dailySpendCents === null
        ? `Used ${formatSpendCents(usage.day.spendMicros)}¢ today · no cap`
        : `Used ${formatSpendCents(usage.day.spendMicros)}¢ / ${budgets.dailySpendCents}¢ today`;
    case 'monthlySpendCents':
      return budgets.monthlySpendCents === null
        ? `Used ${formatSpendCents(usage.month.spendMicros)}¢ this month · no cap`
        : `Used ${formatSpendCents(usage.month.spendMicros)}¢ / ${budgets.monthlySpendCents}¢ this month`;
    case 'dailyRequests':
      return `Used ${usage.day.requests} / ${budgets.dailyRequests} today`;
    case 'monthlyRequests':
      return `Used ${usage.month.requests} / ${budgets.monthlyRequests} this month`;
    case 'dailyOutboundActions':
      return `Used ${usage.day.outboundActions} / ${budgets.dailyOutboundActions} today`;
    case 'monthlyOutboundActions':
      return `Used ${usage.month.outboundActions} / ${budgets.monthlyOutboundActions} this month`;
    case 'maxConcurrentRuns':
      return `Active now ${usage.activeRuns} / ${budgets.maxConcurrentRuns}`;
    default:
      return null;
  }
}

const groups = [
  {
    id: 'spend',
    title: 'Spend caps',
    description: 'OpenRouter spend limits in USD cents. Turn on No cap to leave a period uncapped.',
    keys: ['dailySpendCents', 'monthlySpendCents'] as const,
  },
  {
    id: 'requests',
    title: 'Request quotas',
    description: 'Maximum evaluator and main-model calls.',
    keys: ['dailyRequests', 'monthlyRequests'] as const,
  },
  {
    id: 'outbound',
    title: 'Outbound actions',
    description: 'Maximum policy-allowed external writes.',
    keys: ['dailyOutboundActions', 'monthlyOutboundActions'] as const,
  },
  {
    id: 'run',
    title: 'Run limits',
    description: 'Concurrency, tool steps and wall-clock deadline for a single run.',
    keys: ['maxConcurrentRuns', 'maxToolStepsPerRun', 'runDeadlineSeconds'] as const,
  },
] as const;

const fieldMeta: Record<
  (typeof budgetFields)[number]['key'],
  { shortLabel: string; suffix?: string; min: number }
> = {
  dailySpendCents: { shortLabel: 'Daily spend', suffix: '¢', min: 0 },
  monthlySpendCents: { shortLabel: 'Monthly spend', suffix: '¢', min: 0 },
  dailyRequests: { shortLabel: 'Daily requests', min: 0 },
  monthlyRequests: { shortLabel: 'Monthly requests', min: 0 },
  dailyOutboundActions: { shortLabel: 'Daily outbound', min: 0 },
  monthlyOutboundActions: { shortLabel: 'Monthly outbound', min: 0 },
  maxConcurrentRuns: { shortLabel: 'Concurrency', min: 1 },
  maxToolStepsPerRun: { shortLabel: 'Max tool steps', min: 1 },
  runDeadlineSeconds: { shortLabel: 'Deadline', suffix: 'sec', min: 30 },
};

function BudgetFieldControl({
  fieldKey,
  budgets,
  usage,
}: {
  fieldKey: (typeof budgetFields)[number]['key'];
  budgets: AgentBudgets;
  usage: BudgetUsageView;
}) {
  const field = budgetFields.find((item) => item.key === fieldKey);
  const meta = fieldMeta[fieldKey];
  const canBeUnlimited = fieldKey === 'dailySpendCents' || fieldKey === 'monthlySpendCents';
  const [unlimited, setUnlimited] = useState(() => canBeUnlimited && budgets[fieldKey] === null);
  const used = usageLine(fieldKey, budgets, usage);
  const inputId = `budget-${fieldKey}`;
  const usageId = used ? `${inputId}-usage` : undefined;

  if (!field) return null;

  return (
    <Field className="budget-field gap-2">
      <div className="budget-field-heading">
        <FieldLabel htmlFor={inputId} className="budget-field-label">
          {meta.shortLabel}
        </FieldLabel>
        {canBeUnlimited && (
          <label className="budget-unlimited" htmlFor={`${inputId}-unlimited`}>
            <span>No cap</span>
            <Switch
              id={`${inputId}-unlimited`}
              checked={unlimited}
              onCheckedChange={setUnlimited}
              aria-label={`No cap for ${field.label.toLowerCase()}`}
            />
            {unlimited ? <input type="hidden" name={`${fieldKey}Unlimited`} value="on" /> : null}
          </label>
        )}
      </div>
      <div className={cn('budget-input-wrap', meta.suffix && 'has-suffix')}>
        <Input
          id={inputId}
          name={fieldKey}
          type="number"
          inputMode="numeric"
          min={meta.min}
          defaultValue={budgets[fieldKey] ?? undefined}
          required={!canBeUnlimited || !unlimited}
          disabled={unlimited}
          aria-describedby={usageId}
          className="m-0"
        />
        {meta.suffix ? <span className="budget-suffix">{meta.suffix}</span> : null}
      </div>
      {used && (
        <p id={usageId} className="budget-usage">
          {used}
        </p>
      )}
    </Field>
  );
}

export function BudgetSettings({
  agentId,
  budgets,
  usage,
}: {
  agentId: string;
  budgets: AgentBudgets;
  usage: BudgetUsageView;
}) {
  return (
    <section id="budgets" className="access-workbench">
      <div className="editor-section-heading">
        <h2>Budgets</h2>
        <p className="muted">
          Choose daily and monthly spend limits independently. When either cap is enabled, model
          calls require verified OpenRouter pricing. Request quotas apply with either spend setting.
        </p>
      </div>
      <WorkspaceForm action={saveAgentBudgets} label="Save budgets" saveState>
        <input type="hidden" name="agentId" value={agentId} />
        <div className="budget-groups">
          {groups.map((group) => (
            <Card key={group.id} className="budget-card shadow-none">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{group.title}</CardTitle>
                <CardDescription>{group.description}</CardDescription>
              </CardHeader>
              <CardContent className="budget-card-grid">
                {group.keys.map((key) => (
                  <BudgetFieldControl key={key} fieldKey={key} budgets={budgets} usage={usage} />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </WorkspaceForm>
    </section>
  );
}
