import { setAgentLifecycle } from '@/actions/lifecycle';
import { WorkspaceForm } from '@/app/workspace-form';
import {
  lifecycleDescriptions,
  lifecycleLabels,
  lifecycleStates,
  type LifecycleState,
} from '@/lib/lifecycle';

export function LifecycleControls({
  agentId,
  lifecycle,
}: {
  agentId: string;
  lifecycle: LifecycleState;
}) {
  return (
    <section id="lifecycle" className="access-workbench">
      <div className="editor-section-heading">
        <h2>Lifecycle</h2>
        <p className="muted">
          Only administrators can change lifecycle. Every change is audited. Live activation is
          available as a state, but no external action adapters exist yet — proposals stay
          suppressed.
        </p>
      </div>
      <ul className="lifecycle-grid">
        {lifecycleStates.map((state) => {
          const selected = lifecycle === state;
          return (
            <li key={state} className={`lifecycle-option${selected ? ' selected' : ''}`}>
              <div>
                <h3>{lifecycleLabels[state]}</h3>
                <p className="muted">{lifecycleDescriptions[state]}</p>
              </div>
              {selected ? (
                <span className="state-label">Current</span>
              ) : (
                <WorkspaceForm action={setAgentLifecycle} label={`Set ${lifecycleLabels[state]}`}>
                  <input type="hidden" name="agentId" value={agentId} />
                  <input type="hidden" name="lifecycle" value={state} />
                </WorkspaceForm>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
