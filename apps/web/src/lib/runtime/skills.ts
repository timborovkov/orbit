import { type Tool, tool } from 'ai';
import { z } from 'zod';

import { authorizeAction, type CandidateAction, type PolicyContext } from '@/lib/policy/gateway';
import type { ToolStepGate } from '@/lib/runtime/tool-steps';

export const LOAD_SKILL_TOOL = 'load_skill';

export interface SkillSummary {
  id: string;
  name: string;
  title: string;
  description: string;
  version: number;
  body: string;
}

export interface SkillVersionRecord {
  skillId: string;
  name: string;
  version: number;
  loaded: boolean;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  policy: 'allow' | 'deny' | 'needs-approval' | 'suppressed' | 'denied';
  result: unknown;
  error?: string;
}

/** Compact catalogue for the system prompt — names and when-to-use only. */
export function formatSkillCatalog(skills: Pick<SkillSummary, 'name' | 'description'>[]) {
  if (!skills.length) return '';
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return [
    'Available skills (progressive disclosure). Call load_skill with a skill name to load its full Markdown body. Only listed skills may be loaded.',
    ...lines,
  ].join('\n');
}

export function skillVersionsAttached(skills: SkillSummary[]): SkillVersionRecord[] {
  return skills.map((skill) => ({
    skillId: skill.id,
    name: skill.name,
    version: skill.version,
    loaded: false,
  }));
}

export function createLoadSkillTool(options: {
  skills: SkillSummary[];
  policy: PolicyContext;
  executionToken?: string;
  authorize?: (
    ctx: PolicyContext,
    action: CandidateAction,
  ) => Promise<{
    decision: ToolCallRecord['policy'];
    reasons: string[];
    intentId?: string;
  }>;
  onCall?: (record: ToolCallRecord) => void | Promise<void>;
  versions: SkillVersionRecord[];
  toolSteps?: ToolStepGate;
}): Tool {
  const byName = new Map(options.skills.map((skill) => [skill.name, skill]));
  const authorize = options.authorize ?? authorizeAction;

  return tool({
    description:
      'Load the full Markdown body of an attached skill by its slug name. Use only when the skill catalogue description indicates it is relevant.',
    inputSchema: z.object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    }),
    execute: async ({ name }) => {
      const skill = byName.get(name);
      if (options.toolSteps && !options.toolSteps.tryConsume()) {
        const record: ToolCallRecord = {
          tool: LOAD_SKILL_TOOL,
          args: { name },
          policy: 'deny',
          result: null,
          error: 'Maximum tool steps for this run reached.',
        };
        await options.onCall?.(record);
        return { error: record.error };
      }
      const idempotencyKey = `load_skill:${options.policy.runId ?? 'none'}:${name}:${Date.now()}`;
      const decision = await authorize(options.policy, {
        type: LOAD_SKILL_TOOL,
        readOnly: true,
        executionToken: options.executionToken,
        payload: { name },
        idempotencyKey,
      });

      if (decision.decision !== 'allow') {
        const record: ToolCallRecord = {
          tool: LOAD_SKILL_TOOL,
          args: { name },
          policy: decision.decision,
          result: null,
          error: decision.reasons.join(' '),
        };
        await options.onCall?.(record);
        return { error: decision.reasons.join(' ') || 'load_skill denied by policy.' };
      }

      if (!skill) {
        const record: ToolCallRecord = {
          tool: LOAD_SKILL_TOOL,
          args: { name },
          policy: 'deny',
          result: null,
          error: `Skill "${name}" is not attached to this agent.`,
        };
        await options.onCall?.(record);
        return { error: record.error };
      }

      const version = options.versions.find((entry) => entry.skillId === skill.id);
      if (version) version.loaded = true;

      const result = {
        name: skill.name,
        title: skill.title,
        version: skill.version,
        body: skill.body,
      };
      const record: ToolCallRecord = {
        tool: LOAD_SKILL_TOOL,
        args: { name },
        policy: 'allow',
        result: {
          name: skill.name,
          title: skill.title,
          version: skill.version,
          bodyLength: skill.body.length,
        },
      };
      await options.onCall?.(record);
      return result;
    },
  });
}
