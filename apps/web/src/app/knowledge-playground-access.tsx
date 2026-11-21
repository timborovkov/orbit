'use client';

import { useState, useTransition } from 'react';

import { saveKnowledgeSearchAccess } from '@/actions/knowledge';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';

export function KnowledgePlaygroundAccess({
  agentId,
  searchEnabled,
}: {
  agentId: string;
  searchEnabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <section
      id="knowledge-playground"
      className="access-workbench"
      aria-labelledby="knowledge-playground-title"
    >
      <div className="editor-section-heading">
        <h2 id="knowledge-playground-title">Playground retrieval</h2>
        <p className="muted">
          When enabled, Playground runs can call knowledge.search against ready private documents
          and granted libraries.
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
          disabled={pending}
          aria-label="Use knowledge in Playground"
          onCheckedChange={(enabled) => {
            setError(null);
            const form = new FormData();
            form.set('agentId', agentId);
            form.set('enabled', String(enabled));
            startTransition(async () => {
              try {
                const result = await saveKnowledgeSearchAccess(form);
                if (result.error) setError(result.error);
              } catch {
                setError('Unable to save knowledge search access. Try again.');
              }
            });
          }}
        />
      </Field>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
