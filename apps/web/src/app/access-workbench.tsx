'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  BookOpen,
  KeyRound,
  PauseCircle,
  Plug,
  Scale,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';

import { AccessPanel } from '@/app/access-panel';
import { BudgetSettings, type BudgetUsageView } from '@/app/budget-settings';
import { LifecycleControls } from '@/app/lifecycle-controls';
import { ConsentSettings, ReviewSettings } from '@/app/policy-settings';
import { McpPicker, SkillPicker } from '@/app/resource-pickers';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AgentBudgets } from '@/lib/budgets';
import type { LifecycleState } from '@/lib/lifecycle';
import type { OpenRouterKeySource } from '@/lib/runtime/openrouter-key';
import { accessSectionPanelHidden } from '@/lib/runtime/playground-ui';
import type { getAgentWorkspace } from '@/lib/server/workspace-queries';
import { cn } from '@/lib/utils';

type Workspace = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>;

const sections = [
  { id: 'lifecycle', title: 'Lifecycle', icon: PauseCircle },
  { id: 'budgets', title: 'Budgets', icon: WalletCards },
  { id: 'approvals', title: 'Approvals', icon: Scale },
  { id: 'consent', title: 'Consent', icon: ShieldCheck },
  { id: 'skills', title: 'Skills', icon: BookOpen },
  { id: 'mcp', title: 'MCP', icon: Plug },
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
  skills,
  skillIds,
  mcpConnections,
  mcpConnectionIds,
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
  skills: { id: string; name: string; title: string; description: string; version: number }[];
  skillIds: string[];
  mcpConnections: { id: string; name: string; url: string; transport: string }[];
  mcpConnectionIds: string[];
}) {
  const [active, setActive] = useState<(typeof sections)[number]['id']>('lifecycle');
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const sync = () => {
      setCompact(media.matches);
    };
    sync();
    media.addEventListener('change', sync);
    return () => {
      media.removeEventListener('change', sync);
    };
  }, []);

  useEffect(() => {
    if (compact) return;
    document
      .querySelector<HTMLButtonElement>(`.access-sections button[aria-pressed='true']`)
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [active, compact]);

  const panels: Record<(typeof sections)[number]['id'], ReactNode> = {
    lifecycle: <LifecycleControls agentId={agentId} lifecycle={lifecycle} />,
    budgets: <BudgetSettings agentId={agentId} budgets={budgets} usage={usage} />,
    approvals: <ReviewSettings agentId={agentId} approvalTools={approvalTools} />,
    consent: <ConsentSettings agentId={agentId} consents={consents} />,
    skills: <SkillPicker agentId={agentId} skills={skills} selectedIds={skillIds} />,
    mcp: (
      <McpPicker agentId={agentId} connections={mcpConnections} selectedIds={mcpConnectionIds} />
    ),
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
      {compact ? (
        <div className="access-sections-compact">
          <label className="sr-only" htmlFor="access-section-compact">
            Access section
          </label>
          <Select
            value={active}
            onValueChange={(value) => {
              setActive(value as (typeof sections)[number]['id']);
            }}
          >
            <SelectTrigger
              id="access-section-compact"
              className="w-full"
              aria-label="Access section"
            >
              <SelectValue placeholder="Section" />
            </SelectTrigger>
            <SelectContent>
              {sections.map((section) => (
                <SelectItem key={section.id} value={section.id}>
                  {section.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="access-sections-shell">
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
        </div>
      )}
      <div className="access-fields-body">
        {sections.map((section) => (
          <div
            key={section.id}
            className="access-section-panel"
            hidden={accessSectionPanelHidden(active, section.id)}
          >
            {panels[section.id]}
          </div>
        ))}
      </div>
    </div>
  );
}
