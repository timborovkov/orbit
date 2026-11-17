import { saveAgentBudgets } from '@/actions/lifecycle';
import { WorkspaceForm } from '@/app/workspace-form';
import { budgetFields, type AgentBudgets } from '@/lib/budgets';

export function BudgetSettings({ agentId, budgets }: { agentId: string; budgets: AgentBudgets }) {
  return (
    <section id="budgets" className="access-workbench">
      <div className="editor-section-heading">
        <h2>Budgets</h2>
        <p className="muted">
          Hard caps from architecture defaults. When a limit is reached, work is rejected or
          deferred and shown in run history. OpenRouter monetary cost is recorded when pricing is
          available; otherwise token usage is tracked and spend is treated as zero for enforcement.
        </p>
      </div>
      <WorkspaceForm action={saveAgentBudgets} label="Save budgets" saveState>
        <input type="hidden" name="agentId" value={agentId} />
        <ul className="budget-list">
          {budgetFields.map((field) => (
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
                defaultValue={budgets[field.key]}
                required
              />
              <p className="field-hint">{field.hint}</p>
            </li>
          ))}
        </ul>
      </WorkspaceForm>
    </section>
  );
}
