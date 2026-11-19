'use client';

import { useRouter } from 'next/navigation';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function ApprovalsFilter({
  agents,
  filterAgentId,
}: {
  agents: { id: string; name: string }[];
  filterAgentId: string | null;
}) {
  const router = useRouter();
  const value = filterAgentId ?? 'all';

  return (
    <div className="approvals-filter">
      <div className="approvals-filter-field">
        <Label htmlFor="approvals-agent-filter">Filter by agent</Label>
        <Select
          value={value}
          onValueChange={(next) => {
            const params = new URLSearchParams();
            if (next && next !== 'all') params.set('agent', next);
            const query = params.toString();
            router.push(query ? `/approvals?${query}` : '/approvals');
          }}
        >
          <SelectTrigger id="approvals-agent-filter" className="w-full min-w-0">
            <SelectValue placeholder="All agents" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
