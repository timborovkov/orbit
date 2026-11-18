import { afterAll, expect, test } from 'bun:test';

import { budgetDefaults } from '@/lib/budgets';
import { evaluateActionForTest } from '@/lib/policy/gateway';
import {
  connectMcpClient,
  loadMcpToolsForAgent,
  mcpToolAlias,
  mcpToolId,
  type McpConnectionConfig,
} from '@/lib/runtime/mcp';
import {
  createLoadSkillTool,
  formatSkillCatalog,
  LOAD_SKILL_TOOL,
  skillVersionsAttached,
  type SkillSummary,
} from '@/lib/runtime/skills';
import { createToolStepGate } from '@/lib/runtime/tool-steps';

const policy = {
  actor: 'test@example.com',
  agentId: '00000000-0000-4000-8000-000000000001',
  runId: '00000000-0000-4000-8000-000000000002',
  lifecycle: 'shadow' as const,
  enabledTools: [] as string[],
  approvalTools: [] as string[],
  budgets: budgetDefaults,
  globalPaused: false,
  usage: {
    spendMicros: BigInt(0),
    requests: 0,
    outboundActions: 0,
    month: { spendMicros: BigInt(0), requests: 0, outboundActions: 0 },
    activeRuns: 0,
  },
};

const skills: SkillSummary[] = [
  {
    id: '00000000-0000-4000-8000-000000000010',
    name: 'research-brief',
    title: 'Research brief',
    description: 'Use when drafting a research summary.',
    version: 3,
    body: '# Research brief\n\nCollect sources first.',
  },
];

const execOptions = {
  toolCallId: 't1',
  messages: [] as never[],
  context: {},
};

test('skill catalogue exposes names and descriptions only', () => {
  const catalogue = formatSkillCatalog(skills);
  expect(catalogue).toContain('research-brief');
  expect(catalogue).toContain('Use when drafting a research summary.');
  expect(catalogue).not.toContain('Collect sources first');
});

test('load_skill returns body through policy allow and records version load', async () => {
  const versions = skillVersionsAttached(skills);
  const calls: unknown[] = [];
  const loadSkill = createLoadSkillTool({
    skills,
    policy,
    versions,
    authorize: async (_ctx, action) => {
      expect(action.type).toBe(LOAD_SKILL_TOOL);
      expect(action.readOnly).toBe(true);
      return { decision: 'allow', reasons: ['ok'] };
    },
    onCall: async (record) => {
      calls.push(record);
    },
  });
  expect(loadSkill.execute).toBeDefined();
  const result = await loadSkill.execute!(
    { name: 'research-brief' },
    { ...execOptions, toolCallId: 't1' },
  );
  expect(result).toMatchObject({
    name: 'research-brief',
    version: 3,
    body: skills[0].body,
  });
  expect(versions[0]?.loaded).toBe(true);
  expect(calls).toHaveLength(1);
});

test('load_skill refuses unattached skills and policy denials', async () => {
  const versions = skillVersionsAttached(skills);
  const missing = createLoadSkillTool({
    skills,
    policy,
    versions,
    authorize: async () => ({ decision: 'allow', reasons: ['ok'] }),
  });
  const missingResult = await missing.execute!(
    { name: 'missing-skill' },
    { ...execOptions, toolCallId: 't2' },
  );
  expect(missingResult).toMatchObject({ error: expect.stringContaining('not attached') });

  const denied = createLoadSkillTool({
    skills,
    policy,
    versions,
    authorize: async () => ({ decision: 'deny', reasons: ['blocked'] }),
  });
  const deniedResult = await denied.execute!(
    { name: 'research-brief' },
    { ...execOptions, toolCallId: 't3' },
  );
  expect(deniedResult).toMatchObject({ error: 'blocked' });
});

test('policy gateway permits load_skill and mcp tools when proposal allowlist is set', () => {
  const base = {
    lifecycle: 'shadow' as const,
    enabledTools: ['like'],
    budgets: budgetDefaults,
    globalPaused: false,
  };
  expect(
    evaluateActionForTest(base, {
      type: LOAD_SKILL_TOOL,
      idempotencyKey: 's1',
      readOnly: true,
    }).decision,
  ).toBe('allow');
  expect(
    evaluateActionForTest(base, {
      type: mcpToolId('crm', 'search'),
      idempotencyKey: 'm1',
      readOnly: true,
    }).decision,
  ).toBe('allow');
  expect(evaluateActionForTest(base, { type: 'reply', idempotencyKey: 'r1' }).decision).toBe(
    'deny',
  );
});

function fakeTool<INPUT extends Record<string, unknown>, OUTPUT>(
  execute: (input: INPUT) => Promise<OUTPUT>,
) {
  return {
    description: 'test',
    inputSchema: { jsonSchema: { type: 'object' } },
    execute,
  };
}

test('MCP tools register through the policy gateway and honour allowlists', async () => {
  const connection: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000020',
    name: 'demo',
    url: 'http://127.0.0.1:9/mcp',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: ['echo'],
  };
  const decisions: { type: string; readOnly?: boolean }[] = [];
  const { tools, statuses, close } = await loadMcpToolsForAgent({
    connections: [connection],
    policy,
    authorize: async (_ctx, action) => {
      decisions.push({ type: action.type, readOnly: action.readOnly });
      if (action.type === mcpToolId('demo', 'echo')) {
        return { decision: 'allow', reasons: ['ok'] };
      }
      return { decision: 'deny', reasons: ['not allowed'] };
    },
    connect: async () =>
      ({
        tools: async () => ({
          echo: fakeTool(async (input: { text: string }) => ({ echoed: input.text })),
          secret_admin: fakeTool(async () => ({ ok: true })),
        }),
        close: async () => undefined,
      }) as unknown as Awaited<ReturnType<typeof connectMcpClient>>,
  });

  expect(statuses).toEqual([
    {
      connectionId: connection.id,
      name: 'demo',
      status: 'ready',
      tools: ['echo'],
    },
  ]);
  expect(Object.keys(tools)).toEqual([mcpToolAlias('demo', 'echo')]);
  const result = await tools[mcpToolAlias('demo', 'echo')]!.execute!(
    { text: 'hi' },
    { ...execOptions, toolCallId: 't4' },
  );
  expect(result).toEqual({ echoed: 'hi' });
  expect(decisions).toEqual([{ type: mcpToolId('demo', 'echo'), readOnly: false }]);
  await close();
});

test('MCP aliases stay unique when sanitized connection/tool names collide', async () => {
  const first: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000041',
    name: 'a_b',
    url: 'http://127.0.0.1:9/a',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: null,
  };
  const second: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000042',
    name: 'a',
    url: 'http://127.0.0.1:9/b',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: null,
  };
  const { tools, statuses, close } = await loadMcpToolsForAgent({
    connections: [first, second],
    policy,
    authorize: async () => ({ decision: 'allow', reasons: ['ok'] }),
    connect: async (connection) =>
      ({
        tools: async () =>
          connection.name === 'a_b'
            ? { c: fakeTool(async () => ({ from: 'a_b' })) }
            : { b_c: fakeTool(async () => ({ from: 'a' })) },
        close: async () => undefined,
      }) as unknown as Awaited<ReturnType<typeof connectMcpClient>>,
  });
  expect(statuses.map((row) => row.status)).toEqual(['ready', 'ready']);
  expect(Object.keys(tools).sort()).toEqual(
    [mcpToolAlias('a_b', 'c'), mcpToolAlias('a', 'b_c')].sort(),
  );
  expect(Object.keys(tools)).toHaveLength(2);
  await close();
});

test('MCP connection failures degrade without aborting the tool set', async () => {
  const ok: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000021',
    name: 'ok',
    url: 'http://127.0.0.1:9/ok',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: null,
  };
  const bad: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000022',
    name: 'bad',
    url: 'http://127.0.0.1:9/bad',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: null,
  };
  const { tools, statuses, close } = await loadMcpToolsForAgent({
    connections: [bad, ok],
    policy,
    authorize: async () => ({ decision: 'allow', reasons: ['ok'] }),
    connect: async (connection) => {
      if (connection.name === 'bad') throw new Error('boom');
      return {
        tools: async () => ({
          ping: fakeTool(async () => ({ ok: true })),
        }),
        close: async () => undefined,
      } as unknown as Awaited<ReturnType<typeof connectMcpClient>>;
    },
  });
  expect(statuses.map((row) => row.status)).toEqual(['error', 'ready']);
  expect(Object.keys(tools)).toEqual([mcpToolAlias('ok', 'ping')]);
  await close();
});

let fakeServer: ReturnType<typeof Bun.serve> | undefined;

afterAll(() => {
  fakeServer?.stop(true);
});

test('MCP HTTP fake server tools register and execute through policy', async () => {
  fakeServer = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method', { status: 405 });
      const message = (await request.json()) as {
        jsonrpc: string;
        id?: string | number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (message.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'orbit-fake', version: '1.0.0' },
          },
        });
      }
      if (message.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (message.method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Echo text',
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                },
              },
            ],
          },
        });
      }
      if (message.method === 'tools/call') {
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [
              {
                type: 'text',
                text: String(message.params?.arguments?.text ?? ''),
              },
            ],
          },
        });
      }
      return Response.json({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unknown method ${message.method}` },
      });
    },
  });

  const url = `http://127.0.0.1:${fakeServer.port}/mcp`;
  const connection: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000030',
    name: 'local-fake',
    url,
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: ['echo'],
  };
  const { tools, statuses, close } = await loadMcpToolsForAgent({
    connections: [connection],
    policy,
    authorize: async (_ctx, action) => {
      expect(action.type).toBe(mcpToolId('local-fake', 'echo'));
      return { decision: 'allow', reasons: ['ok'] };
    },
  });
  expect(statuses[0]?.status).toBe('ready');
  expect(Object.keys(tools)).toEqual([mcpToolAlias('local-fake', 'echo')]);
  const result = await tools[mcpToolAlias('local-fake', 'echo')]!.execute!(
    { text: 'orbit' },
    { ...execOptions, toolCallId: 't5' },
  );
  expect(result).toMatchObject({
    content: [{ type: 'text', text: 'orbit' }],
  });
  await close();
});

test('tool step gate blocks further MCP and skill calls once exhausted', async () => {
  const gate = createToolStepGate(1);
  const connection: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000031',
    name: 'gated',
    url: 'http://127.0.0.1:9/mcp',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: null,
  };
  const { tools, close } = await loadMcpToolsForAgent({
    connections: [connection],
    policy,
    toolSteps: gate,
    authorize: async () => ({ decision: 'allow', reasons: ['ok'] }),
    connect: async () =>
      ({
        tools: async () => ({
          a: fakeTool(async () => ({ ok: 1 })),
          b: fakeTool(async () => ({ ok: 2 })),
        }),
        close: async () => undefined,
      }) as unknown as Awaited<ReturnType<typeof connectMcpClient>>,
  });
  const first = await tools[mcpToolAlias('gated', 'a')]!.execute!(
    {},
    { ...execOptions, toolCallId: 'g1' },
  );
  expect(first).toEqual({ ok: 1 });
  const second = await tools[mcpToolAlias('gated', 'b')]!.execute!(
    {},
    { ...execOptions, toolCallId: 'g2' },
  );
  expect(second).toEqual({ error: 'Maximum tool steps for this run reached.' });
  await close();

  const loadSkill = createLoadSkillTool({
    skills,
    policy,
    versions: skillVersionsAttached(skills),
    toolSteps: createToolStepGate(0),
    authorize: async () => ({ decision: 'allow', reasons: ['ok'] }),
  });
  const blocked = await loadSkill.execute!(
    { name: 'research-brief' },
    { ...execOptions, toolCallId: 'g3' },
  );
  expect(blocked).toEqual({ error: 'Maximum tool steps for this run reached.' });
});

test('MCP discovery aborts when the run signal expires', async () => {
  let closed = 0;
  const connection: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000033',
    name: 'hang',
    url: 'http://127.0.0.1:9/mcp',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: null,
  };
  const controller = new AbortController();
  const { statuses, close } = await loadMcpToolsForAgent({
    connections: [connection],
    policy,
    signal: controller.signal,
    authorize: async () => ({ decision: 'allow', reasons: ['ok'] }),
    connect: async () =>
      ({
        tools: async () =>
          await new Promise(() => {
            // Never resolves — discovery must be cancelled by the run signal.
            controller.abort();
          }),
        close: async () => {
          closed += 1;
        },
      }) as unknown as Awaited<ReturnType<typeof connectMcpClient>>,
  });
  expect(statuses[0]?.status).toBe('error');
  expect(closed).toBe(1);
  await close();
});

test('MCP discovery failure closes an initialized client', async () => {
  let closed = 0;
  const connection: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000032',
    name: 'leaky',
    url: 'http://127.0.0.1:9/mcp',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: null,
  };
  const { statuses, close } = await loadMcpToolsForAgent({
    connections: [connection],
    policy,
    authorize: async () => ({ decision: 'allow', reasons: ['ok'] }),
    connect: async () =>
      ({
        tools: async () => {
          throw new Error('tools/list failed');
        },
        close: async () => {
          closed += 1;
        },
      }) as unknown as Awaited<ReturnType<typeof connectMcpClient>>,
  });
  expect(statuses[0]?.status).toBe('error');
  expect(closed).toBe(1);
  await close();
});

test('read-only authorization still enforces concurrency from the policy snapshot', () => {
  const denied = evaluateActionForTest(
    {
      lifecycle: 'shadow',
      enabledTools: [],
      approvalTools: undefined,
      budgets: budgetDefaults,
      globalPaused: false,
      usage: {
        spendMicros: BigInt(0),
        requests: 0,
        outboundActions: 0,
        month: { spendMicros: BigInt(0), requests: 0, outboundActions: 0 },
        activeRuns: 1,
      },
    },
    {
      type: LOAD_SKILL_TOOL,
      readOnly: true,
      idempotencyKey: 'concurrency-check',
    },
  );
  expect(denied.decision).toBe('deny');
  expect(denied.violation).toBe('concurrency');
});

test('MCP model-facing aliases are OpenAI-compatible while policy keeps canonical ids', () => {
  const alias = mcpToolAlias('crm', 'search');
  expect(alias).toMatch(/^mcp_crm_search_[a-f0-9]{6}$/);
  expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  expect(mcpToolId('crm', 'search')).toBe('mcp:crm:search');
  const long = mcpToolAlias('a'.repeat(80), 'b'.repeat(80));
  expect(long.length).toBeLessThanOrEqual(64);
  expect(long).toMatch(/^[a-zA-Z0-9_-]+$/);
  // Sanitized name collisions across connections stay distinct via the digest.
  expect(mcpToolAlias('a_b', 'c')).not.toBe(mcpToolAlias('a', 'b_c'));
});

test('load_skill does not require a spare inference request slot', () => {
  const allowed = evaluateActionForTest(
    {
      lifecycle: 'shadow',
      enabledTools: [],
      approvalTools: undefined,
      budgets: { ...budgetDefaults, dailyRequests: 12, monthlyRequests: 12 },
      globalPaused: false,
      usage: {
        spendMicros: BigInt(0),
        // Evaluator (1) + main tool-loop reservation (11) already filled the day.
        requests: 12,
        outboundActions: 0,
        month: { spendMicros: BigInt(0), requests: 12, outboundActions: 0 },
        activeRuns: 0,
      },
    },
    {
      type: LOAD_SKILL_TOOL,
      readOnly: true,
      idempotencyKey: 'skill-no-extra-request',
    },
  );
  expect(allowed.decision).toBe('allow');
});

test('tool-step limit for proposals counts invocations, not inference stages', async () => {
  const { checkToolStepLimit } = await import('@/lib/budgets');
  // Nine tool calls + two model stages must not trip a limit of ten.
  expect(checkToolStepLimit(9, budgetDefaults)).toBeNull();
  expect(checkToolStepLimit(2 + 9, budgetDefaults)).toBe('tool-steps');
  expect(checkToolStepLimit(11, budgetDefaults)).toBe('tool-steps');
});
