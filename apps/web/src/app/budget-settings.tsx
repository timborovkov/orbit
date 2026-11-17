import { saveAgentBudgets } from '@/actions/lifecycle';
import { WorkspaceForm } from '@/app/workspace-form';
import { budgetFields, type AgentBudgets } from '@/lib/budgets';

export function BudgetSettings({ agentId, budgets }: { agentId: string; budgets: AgentBudgets }) {
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
            return (
              <li key={field.key}>
                <label htmlFor={`budget-${field.key}`}>{field.label}</label>
                <input
                  id={`budget-${field.key}`}
                  name={field.key}
                  type="number"
                  inputMode="numeric"
                  min={
                    field.key === 'maxConcurrentRuns' || field.key === 'maxToolStepsPerRun' ? 1 : 0
                  }
                  defaultValue={budgets[field.key] ?? undefined}
                  required={!canBeUnlimited}
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
                <p className="field-hint">{field.hint}</p>
              </li>
            );
          })}
        </ul>
      </WorkspaceForm>
    </section>
  );
}
