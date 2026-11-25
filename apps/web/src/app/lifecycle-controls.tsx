'use client';

import { setAgentLifecycle } from '@/actions/lifecycle';
import { WorkspaceForm } from '@/app/workspace-form';
import {
  lifecycleDescriptions,
  lifecycleLabels,
  type LifecycleState,
  lifecycleStates,
} from '@/lib/lifecycle';
import { cn } from '@/lib/utils';

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
          Administrator-only. Live sends still need channel access and policy.
        </p>
      </div>
      <ul className="lifecycle-cards" role="list" aria-label="Agent lifecycle">
        {lifecycleStates.map((state) => {
          const selected = lifecycle === state;
          return (
            <li key={state} className={cn('lifecycle-card', selected && 'is-selected')}>
              <div className="lifecycle-card-copy">
                <div className="lifecycle-card-title">
                  <h3>{lifecycleLabels[state]}</h3>
                  {selected ? <span className="state-label">Current</span> : null}
                </div>
                <p className="muted">{lifecycleDescriptions[state]}</p>
              </div>
              {!selected && (
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
