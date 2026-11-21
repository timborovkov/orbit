'use client';

import { useState, useTransition } from 'react';

import { saveKnowledgeLibraryGrant } from '@/actions/knowledge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function AgentKnowledgeGrant({
  libraryId,
  agent,
}: {
  libraryId: string;
  agent: { id: string; name: string; granted: boolean };
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const label = agent.granted ? 'Revoke access' : 'Grant access';

  function changeAccess() {
    const form = new FormData();
    form.set('agentId', agent.id);
    form.set('libraryId', libraryId);
    form.set('granted', String(!agent.granted));
    setError(null);
    startTransition(async () => {
      try {
        const result = await saveKnowledgeLibraryGrant(form);
        if (result.error) setError(result.error);
      } catch {
        setError('Unable to update access. Try again.');
      }
    });
  }

  return (
    <li className="knowledge-row">
      <div>
        <strong>{agent.name}</strong>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="knowledge-grant-actions">
        <Badge variant="outline" role="status">
          {agent.granted ? 'Has access' : 'No access'}
        </Badge>
        <Button
          variant="outline"
          type="button"
          disabled={pending}
          aria-label={`${label} for ${agent.name}`}
          onClick={changeAccess}
        >
          {pending ? 'Saving…' : label}
        </Button>
      </div>
    </li>
  );
}
