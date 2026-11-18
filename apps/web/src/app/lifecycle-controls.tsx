'use client';

import { setAgentLifecycle } from '@/actions/lifecycle';
import { WorkspaceForm } from '@/app/workspace-form';
import { Button } from '@/components/ui/button';
import {
  lifecycleDescriptions,
  lifecycleLabels,
  lifecycleStates,
  type LifecycleState,
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
          Only administrators can change lifecycle. Every change is audited. Live activation is
          available as a state, but no external action adapters exist yet — proposals stay
          suppressed.
        </p>
      </div>
      <div className="lifecycle-cards" role="radiogroup" aria-label="Agent lifecycle">
        {lifecycleStates.map((state) => {
          const selected = lifecycle === state;
          return (
            <div
              key={state}
              role="radio"
              aria-checked={selected}
              className={cn('lifecycle-card', selected && 'is-selected')}
            >
              <div className="lifecycle-card-copy">
                <div className="lifecycle-card-title">
                  <h3>{lifecycleLabels[state]}</h3>
                  {selected ? <span className="state-label">Current</span> : null}
                </div>
                <p className="muted">{lifecycleDescriptions[state]}</p>
              </div>
              {selected ? (
                <Button type="button" variant="outline" disabled>
                  Selected
                </Button>
              ) : (
                <WorkspaceForm action={setAgentLifecycle} label={`Set ${lifecycleLabels[state]}`}>
                  <input type="hidden" name="agentId" value={agentId} />
                  <input type="hidden" name="lifecycle" value={state} />
                </WorkspaceForm>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
