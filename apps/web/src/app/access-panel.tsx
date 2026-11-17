import { KeyRound } from 'lucide-react';

import { AccessCredentialForms } from '@/app/access-credential-forms';
import type { OpenRouterKeySource } from '@/lib/runtime/openrouter-key';

const copy: Record<OpenRouterKeySource, { title: string; status: string; detail: string }> = {
  agent: {
    title: "Using this agent's key",
    status: 'Agent key',
    detail:
      'An agent-specific key is saved encrypted. Enter a new key to replace it, or remove it to fall back to the environment default when one is configured.',
  },
  environment: {
    title: 'Using environment default',
    status: 'Environment default',
    detail:
      'No agent-specific key. Simulations use the server OPENROUTER_API_KEY. Add a key below to override it for this agent only.',
  },
  none: {
    title: 'No key available',
    status: 'Not connected',
    detail:
      'No agent-specific key and no environment default. Add a key to run simulations, or set OPENROUTER_API_KEY on the server.',
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
          <p className="muted" role="status">
            {state.detail}
          </p>
        </div>
        <span className="state-label">{state.status}</span>
      </div>
      <AccessCredentialForms agentId={agentId} hasAgentCredential={hasAgentCredential} />
    </section>
  );
}
