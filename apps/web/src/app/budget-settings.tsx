import { saveAgentBudgets } from '@/actions/lifecycle';
import { WorkspaceForm } from '@/app/workspace-form';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { budgetFields, type AgentBudgets } from '@/lib/budgets';

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
        <ul className="budget-list">
          {budgetFields.map((field) => {
            const canBeUnlimited =
              field.key === 'dailySpendCents' || field.key === 'monthlySpendCents';
            const used = usageLine(field.key, budgets, usage);
            const inputId = `budget-${field.key}`;
            const hintId = `${inputId}-hint`;
            const usageId = used ? `${inputId}-usage` : undefined;
            return (
              <li key={field.key}>
                <Field className="max-w-sm gap-2">
                  <FieldLabel htmlFor={inputId}>{field.label}</FieldLabel>
                  <Input
                    id={inputId}
                    name={field.key}
                    type="number"
                    inputMode="numeric"
                    min={
                      field.key === 'maxConcurrentRuns' || field.key === 'maxToolStepsPerRun'
                        ? 1
                        : 0
                    }
                    defaultValue={budgets[field.key] ?? undefined}
                    required={!canBeUnlimited}
                    aria-describedby={[usageId, hintId].filter(Boolean).join(' ')}
                    className="m-0 max-w-60"
                  />
                  {canBeUnlimited && (
                    <label className="budget-unlimited">
                      <input
                        type="checkbox"
                        name={`${field.key}Unlimited`}
                        defaultChecked={budgets[field.key] === null}
                      />
                      No cap <span className="sr-only">for {field.label.toLowerCase()}</span>
                    </label>
                  )}
                  {used && (
                    <p id={usageId} className="budget-usage">
                      {used}
                    </p>
                  )}
                  <FieldDescription id={hintId}>{field.hint}</FieldDescription>
                </Field>
              </li>
            );
          })}
        </ul>
      </WorkspaceForm>
    </section>
  );
}
