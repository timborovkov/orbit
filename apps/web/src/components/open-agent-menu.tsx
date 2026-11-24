import Link from 'next/link';

import { Bot, ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface AgentOption {
  id: string;
  name: string;
}

export function OpenAgentMenu({
  agents,
  section,
  label,
}: {
  agents: AgentOption[];
  section: 'skills' | 'mcp';
  label: string;
}) {
  if (!agents.length) return null;
  return (
    <div className="library-attach">
      <span className="muted">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            <Bot size={16} aria-hidden="true" />
            Open agent
            <ChevronDown size={14} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="library-menu">
          {agents.map((agent) => (
            <DropdownMenuItem key={agent.id} asChild>
              <Link href={`/agents/${agent.id}?tab=access&access=${section}`}>{agent.name}</Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
