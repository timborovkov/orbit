import type { ReactNode } from 'react';

import { KeyRound } from 'lucide-react';

import { AccessCredentialForms } from '@/app/access-credential-forms';
import { TermHint } from '@/components/term-hint';
import { FieldDescription } from '@/components/ui/field';
import type { OpenRouterKeySource } from '@/lib/runtime/openrouter-key';

const serverKeyHint = (
  <TermHint hint="Set as OPENROUTER_API_KEY on the server">server default key</TermHint>
);

const copy: Record<OpenRouterKeySource, { title: string; status: string; detail: ReactNode }> = {
  agent: {
    title: "Using this agent's key",
    status: 'Agent key',
    detail:
      'An agent-specific key is saved encrypted. Enter a new key to replace it, or remove it to fall back to the environment default when one is configured.',
  },
  environment: {
    title: 'Using environment default',
    status: 'Environment default',
    detail: (
      <>
        No agent-specific key. Simulations use the {serverKeyHint}. Add a key below to override it
        for this agent only.
      </>
    ),
  },
  none: {
    title: 'No key available',
    status: 'Not connected',
    detail: (
      <>
        No agent-specific key and no {serverKeyHint}. Add a key to run simulations, or ask an
        administrator to configure a server default.
      </>
    ),
  },
};

export function AccessPanel({
  agentId,
  agentName,
  hasAgentCredential,
  keySource,
}: {
  agentId: string;
  agentName: string;
  hasAgentCredential: boolean;
  keySource: OpenRouterKeySource;
}) {
  const state = copy[keySource];
  return (
    <section id="credential" className="access-workbench">
      <div className="editor-section-heading">
        <h2>OpenRouter connection</h2>
        <p className="muted">
          Prefer an agent-specific key for {agentName}, or rely on the optional server default. Keys
          are never shown here, included in prompts or written to diagnostics.
        </p>
      </div>
      <div className="connection-status">
        <KeyRound size={20} aria-hidden="true" />
        <div>
          <h3>{state.title}</h3>
          <FieldDescription className="mt-1" role="status">
            {state.detail}
          </FieldDescription>
        </div>
        <span className="state-label">{state.status}</span>
      </div>
      <AccessCredentialForms agentId={agentId} hasAgentCredential={hasAgentCredential} />
    </section>
  );
}
