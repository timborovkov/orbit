'use client';

import { useState, type ReactNode } from 'react';
import { KeyRound, PauseCircle, Scale, ShieldCheck, WalletCards } from 'lucide-react';

import { AccessPanel } from '@/app/access-panel';
import { BudgetSettings, type BudgetUsageView } from '@/app/budget-settings';
import { LifecycleControls } from '@/app/lifecycle-controls';
import { ConsentSettings, ReviewSettings } from '@/app/policy-settings';
import type { AgentBudgets } from '@/lib/budgets';
import type { LifecycleState } from '@/lib/lifecycle';
import type { OpenRouterKeySource } from '@/lib/runtime/openrouter-key';
import type { getAgentWorkspace } from '@/lib/server/workspace-queries';
import { cn } from '@/lib/utils';

type Workspace = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>;

const sections = [
  { id: 'lifecycle', title: 'Lifecycle', icon: PauseCircle },
  { id: 'budgets', title: 'Budgets', icon: WalletCards },
  { id: 'approvals', title: 'Approvals', icon: Scale },
  { id: 'consent', title: 'Consent', icon: ShieldCheck },
  { id: 'openrouter', title: 'OpenRouter', icon: KeyRound },
] as const;

export function AccessWorkbench({
  agentId,
  agentName,
  lifecycle,
  budgets,
  usage,
  approvalTools,
  consents,
  hasAgentCredential,
  keySource,
}: {
  agentId: string;
  agentName: string;
  lifecycle: LifecycleState;
  budgets: AgentBudgets;
  usage: BudgetUsageView;
  approvalTools: string[];
  consents: Workspace['consents'];
  hasAgentCredential: boolean;
  keySource: OpenRouterKeySource;
}) {
  const [active, setActive] = useState<(typeof sections)[number]['id']>('lifecycle');
  const panels: Record<(typeof sections)[number]['id'], ReactNode> = {
    lifecycle: <LifecycleControls agentId={agentId} lifecycle={lifecycle} />,
    budgets: <BudgetSettings agentId={agentId} budgets={budgets} usage={usage} />,
    approvals: <ReviewSettings agentId={agentId} approvalTools={approvalTools} />,
    consent: <ConsentSettings agentId={agentId} consents={consents} />,
    openrouter: (
      <AccessPanel
        agentId={agentId}
        agentName={agentName}
        hasAgentCredential={hasAgentCredential}
        keySource={keySource}
      />
    ),
  };

  return (
    <div className="access-editor">
      <nav className="access-sections" aria-label="Access sections">
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            aria-pressed={active === section.id}
            className={cn(active === section.id && 'is-active')}
            onClick={() => {
              setActive(section.id);
            }}
          >
            <section.icon size={16} aria-hidden="true" />
            {section.title}
          </button>
        ))}
      </nav>
      <div className="access-fields-body">{panels[active]}</div>
    </div>
  );
}
