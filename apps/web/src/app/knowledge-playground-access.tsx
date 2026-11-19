'use client';

import { useTransition } from 'react';

import { saveKnowledgeSearchAccess } from '@/actions/knowledge';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';

export function KnowledgePlaygroundAccess({
  agentId,
  searchEnabled,
  pending,
  onToggle,
}: {
  agentId: string;
  searchEnabled: boolean;
  pending?: boolean;
  onToggle?: (enabled: boolean) => void;
}) {
  const [localPending, startTransition] = useTransition();
  const busy = pending ?? localPending;

  return (
    <section
      id="knowledge-playground"
      className="access-workbench"
      aria-labelledby="knowledge-playground-title"
    >
      <div className="editor-section-heading">
        <h2 id="knowledge-playground-title">Playground retrieval</h2>
        <p className="muted">
          When enabled, Playground runs can call knowledge.search against this agent’s ready
          documents.
        </p>
      </div>
      <Field orientation="horizontal" className="items-center justify-between gap-4">
        <div className="space-y-1">
          <FieldLabel htmlFor="knowledge-playground-toggle">Use knowledge in Playground</FieldLabel>
          <FieldDescription>
            Policy still gates each search under this agent’s budgets.
          </FieldDescription>
        </div>
        <Switch
          id="knowledge-playground-toggle"
          checked={searchEnabled}
          disabled={busy}
          aria-label="Use knowledge in Playground"
          onCheckedChange={(enabled) => {
            if (onToggle) {
              onToggle(enabled);
              return;
            }
            const form = new FormData();
            form.set('agentId', agentId);
            form.set('enabled', String(enabled));
            startTransition(async () => {
              await saveKnowledgeSearchAccess(form);
            });
          }}
        />
      </Field>
    </section>
  );
}
