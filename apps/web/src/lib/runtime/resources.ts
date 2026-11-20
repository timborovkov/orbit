import type { Tool } from 'ai';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import type { PolicyContext } from '@/lib/policy/gateway';
import { loadMcpToolsForAgent, type McpConnectionConfig } from '@/lib/runtime/mcp';
import {
  createLoadSkillTool,
  formatSkillCatalog,
  LOAD_SKILL_TOOL,
  type SkillSummary,
  skillVersionsAttached,
  type ToolCallRecord,
} from '@/lib/runtime/skills';
import { createToolStepGate } from '@/lib/runtime/tool-steps';
import { agentMcpConnections, agentSkills, mcpConnections, skills } from '@/lib/schema';

async function loadAgentSkills(agentId: string): Promise<SkillSummary[]> {
  return await db()
    .select({
      id: skills.id,
      name: skills.name,
      title: skills.title,
      description: skills.description,
      version: skills.version,
      body: skills.body,
    })
    .from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .where(eq(agentSkills.agentId, agentId));
}

async function loadAgentMcpConnections(agentId: string): Promise<McpConnectionConfig[]> {
  return await db()
    .select({
      id: mcpConnections.id,
      name: mcpConnections.name,
      url: mcpConnections.url,
      transport: mcpConnections.transport,
      encryptedHeaders: mcpConnections.encryptedHeaders,
      toolAllowlist: mcpConnections.toolAllowlist,
      grantedTools: agentMcpConnections.toolNames,
    })
    .from(agentMcpConnections)
    .innerJoin(mcpConnections, eq(agentMcpConnections.connectionId, mcpConnections.id))
    .where(eq(agentMcpConnections.agentId, agentId));
}

/** Build skill catalogue + tools for a run. Caller must close MCP clients. */
export async function prepareRunTools(options: {
  agentId: string;
  policy: PolicyContext;
  executionToken?: string;
  signal?: AbortSignal;
  maxToolSteps?: number;
  onCall?: (record: ToolCallRecord) => void | Promise<void>;
}) {
  const [attachedSkills, connections] = await Promise.all([
    loadAgentSkills(options.agentId),
    loadAgentMcpConnections(options.agentId),
  ]);
  const versions = skillVersionsAttached(attachedSkills);
  const toolCalls: ToolCallRecord[] = [];
  const toolSteps = createToolStepGate(
    options.maxToolSteps ?? options.policy.budgets.maxToolStepsPerRun,
  );
  const record = async (entry: ToolCallRecord) => {
    toolCalls.push(entry);
    await options.onCall?.(entry);
  };

  const tools: Record<string, Tool> = {};
  if (attachedSkills.length) {
    tools[LOAD_SKILL_TOOL] = createLoadSkillTool({
      skills: attachedSkills,
      policy: options.policy,
      executionToken: options.executionToken,
      versions,
      onCall: record,
      toolSteps,
    });
  }

  const mcp = await loadMcpToolsForAgent({
    connections,
    policy: options.policy,
    executionToken: options.executionToken,
    signal: options.signal,
    onCall: record,
    toolSteps,
  });
  Object.assign(tools, mcp.tools);

  return {
    skillCatalog: formatSkillCatalog(attachedSkills),
    skillVersions: versions,
    mcpConnections: mcp.statuses,
    tools,
    toolCalls,
    toolSteps,
    close: mcp.close,
  };
}
