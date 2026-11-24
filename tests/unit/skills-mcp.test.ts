import { afterAll, expect, test } from 'bun:test';

import { budgetDefaults } from '@/lib/budgets';
import { mcpToolId, normalizeMcpAllowlist } from '@/lib/mcp-allowlist';
import { evaluateActionForTest, evaluateCandidate } from '@/lib/policy/gateway';
import {
  connectMcpClient,
  decodeMcpHeaders,
  loadMcpToolsForAgent,
  type McpConnectionConfig,
  mcpHeadersFromRows,
  mcpToolAlias,
  sameMcpEndpoint,
} from '@/lib/runtime/mcp';
import { encryptSecret } from '@/lib/runtime/secrets';
import {
  createLoadSkillTool,
  formatSkillCatalog,
  LOAD_SKILL_TOOL,
  type SkillSummary,
  skillVersionsAttached,
} from '@/lib/runtime/skills';
import { createToolStepGate } from '@/lib/runtime/tool-steps';

const policy = {
  actor: 'test@example.com',
  agentId: '00000000-0000-4000-8000-000000000001',
  runId: '00000000-0000-4000-8000-000000000002',
  lifecycle: 'shadow' as const,
  executionContext: 'standard' as const,
  enabledTools: [] as string[],
  approvalTools: [] as string[],
  consentRequiredTools: [],
  approvalSpendCents: null as number | null,
  approvalExpiresAfterHours: null as number | null,
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

test('MCP allowlist normalization keeps legacy strings mutating', () => {
  expect(normalizeMcpAllowlist(['search', { name: 'get', readOnly: true }])).toEqual([
    { name: 'search', readOnly: false },
    { name: 'get', readOnly: true },
  ]);
  expect(normalizeMcpAllowlist([])).toBeNull();
});

test('MCP credentials are scoped to the full URL and transport', () => {
  const previous = process.env.ORBIT_ENCRYPTION_KEY;
  process.env.ORBIT_ENCRYPTION_KEY = 'a'.repeat(64);
  try {
    const id = '00000000-0000-4000-8000-0000000000aa';
    const headers = mcpHeadersFromRows([{ key: 'Authorization', value: ' Bearer fixture ' }]);
    expect(headers).toEqual({ Authorization: 'Bearer fixture' });
    expect(decodeMcpHeaders(id, encryptSecret(id, JSON.stringify(headers)))).toEqual(headers);
    expect(mcpHeadersFromRows([{ key: 'Authorization', value: '   ' }])).toBeUndefined();
    const saved = { url: 'https://example.test/mcp', transport: 'http' } as const;
    expect(sameMcpEndpoint(saved, { ...saved, url: 'https://example.test:443/mcp' })).toBe(true);
    expect(sameMcpEndpoint(saved, { ...saved, url: 'https://example.test/other' })).toBe(false);
    expect(sameMcpEndpoint(saved, { ...saved, url: 'https://different.test/mcp' })).toBe(false);
    expect(sameMcpEndpoint(saved, { ...saved, transport: 'sse' })).toBe(false);
  } finally {
    if (previous) process.env.ORBIT_ENCRYPTION_KEY = previous;
    else delete process.env.ORBIT_ENCRYPTION_KEY;
  }
});

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

test('policy requires a separate MCP tool grant when a proposal allowlist is set', () => {
  const base = {
    lifecycle: 'shadow' as const,
    executionContext: 'standard' as const,
    enabledTools: ['like'],
    consentRequiredTools: [],
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
  ).toBe('deny');
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
    toolAllowlist: [
      { name: 'echo', readOnly: true },
      { name: 'secret_admin', readOnly: true },
    ],
    grantedTools: ['echo'],
  };
  const decisions: { type: string; readOnly?: boolean }[] = [];
  const { tools, statuses, close } = await loadMcpToolsForAgent({
    connections: [connection],
    policy,
    authorize: async (_ctx, action) => {
      decisions.push({ type: action.type, readOnly: action.readOnly });
      // Use the real gateway evaluator so allow depends on admin readOnly marks.
      return evaluateCandidate(policy, action, null, true);
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
  expect(decisions).toEqual([{ type: mcpToolId('demo', 'echo'), readOnly: true }]);
  await close();
});

test('unclassified and mutating MCP tools are never exposed, even if granted', async () => {
  const connection: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000021',
    name: 'crm',
    url: 'http://127.0.0.1:9/mcp',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: ['search', { name: 'write', readOnly: false }],
    grantedTools: ['search', 'write', 'unknown'],
  };
  let connected = false;
  const { tools, close } = await loadMcpToolsForAgent({
    connections: [connection],
    policy: { ...policy, globalPaused: true },
    connect: async () => {
      connected = true;
      throw new Error('Connection should not be opened without a callable grant');
    },
  });
  expect(connected).toBe(false);
  expect(tools).toEqual({});
  await close();
});

test('MCP tool failures omit remote error contents', async () => {
  const connection: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000021',
    name: 'failing',
    url: 'http://127.0.0.1:9/mcp',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: [
      { name: 'search', readOnly: true },
      { name: 'get', readOnly: true },
    ],
    grantedTools: ['search', 'get'],
  };
  const calls: unknown[] = [];
  const { tools, close } = await loadMcpToolsForAgent({
    connections: [connection],
    policy,
    authorize: async () => ({ decision: 'allow', reasons: [] }),
    onCall: (record) => {
      calls.push(record);
    },
    connect: async () =>
      ({
        tools: async () => ({
          search: fakeTool(async () => {
            throw new Error('private transport response');
          }),
          get: fakeTool(async () => ({
            isError: true,
            content: [{ type: 'text', text: 'private remote error' }],
          })),
        }),
        close: async () => undefined,
      }) as unknown as Awaited<ReturnType<typeof connectMcpClient>>,
  });
  for (const tool of Object.values(tools)) {
    expect(await tool.execute!({}, execOptions)).toEqual({ error: 'MCP tool execution failed.' });
  }
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(calls)).not.toContain('private');
  await close();
});

test('MCP aliases stay unique when sanitized connection/tool names collide', async () => {
  const first: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000041',
    name: 'a_b',
    url: 'http://127.0.0.1:9/a',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: [{ name: 'c', readOnly: true }],
    grantedTools: ['c'],
  };
  const second: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000042',
    name: 'a',
    url: 'http://127.0.0.1:9/b',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: [{ name: 'b_c', readOnly: true }],
    grantedTools: ['b_c'],
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
    toolAllowlist: [{ name: 'ping', readOnly: true }],
    grantedTools: ['ping'],
  };
  const bad: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000022',
    name: 'bad',
    url: 'http://127.0.0.1:9/bad',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: [{ name: 'ping', readOnly: true }],
    grantedTools: ['ping'],
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

test('MCP HTTP tools execute through policy and bound a stalled session close', async () => {
  const closingSessions: (string | null)[] = [];
  fakeServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method === 'DELETE') {
        closingSessions.push(request.headers.get('mcp-session-id'));
        return await new Promise<Response>(() => {});
      }
      if (request.method !== 'POST') return new Response('method', { status: 405 });
      const message = (await request.json()) as {
        jsonrpc: string;
        id?: string | number;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (message.method === 'initialize') {
        return Response.json(
          {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'orbit-fake', version: '1.0.0' },
            },
          },
          { headers: { 'mcp-session-id': 'http-fixture-session' } },
        );
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
    toolAllowlist: [{ name: 'echo', readOnly: true }],
    grantedTools: ['echo'],
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
  expect(closingSessions).toEqual(['http-fixture-session']);
});

test('tool step gate blocks further MCP and skill calls once exhausted', async () => {
  const gate = createToolStepGate(1);
  const connection: McpConnectionConfig = {
    id: '00000000-0000-4000-8000-000000000031',
    name: 'gated',
    url: 'http://127.0.0.1:9/mcp',
    transport: 'http',
    encryptedHeaders: null,
    toolAllowlist: [
      { name: 'a', readOnly: true },
      { name: 'b', readOnly: true },
    ],
    grantedTools: ['a', 'b'],
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
    toolAllowlist: [{ name: 'hang', readOnly: true }],
    grantedTools: ['hang'],
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
    toolAllowlist: [{ name: 'leaky', readOnly: true }],
    grantedTools: ['leaky'],
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
      consentRequiredTools: [],
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

  // Inside an already-admitted run, load_skill and read-only MCP do not open another run slot.
  const inRunPolicy = {
    ...policy,
    runId: '11111111-1111-4111-8111-111111111111',
    runOrigin: 'playground' as const,
    budgets: budgetDefaults,
    usage: {
      spendMicros: BigInt(0),
      requests: 0,
      outboundActions: 0,
      month: { spendMicros: BigInt(0), requests: 0, outboundActions: 0 },
      activeRuns: 1,
    },
  };
  expect(
    evaluateCandidate(
      inRunPolicy,
      {
        type: LOAD_SKILL_TOOL,
        readOnly: true,
        idempotencyKey: 'in-run-skill-allowed',
      },
      null,
      false,
    ).decision,
  ).toBe('allow');
  expect(
    evaluateCandidate(
      inRunPolicy,
      {
        type: mcpToolId('crm', 'search'),
        readOnly: true,
        idempotencyKey: 'in-run-mcp-allowed',
      },
      null,
      true,
    ).decision,
  ).toBe('allow');
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

test('load_skill and read-only MCP do not require spare inference quota', () => {
  const saturated = {
    lifecycle: 'shadow' as const,
    executionContext: 'standard' as const,
    enabledTools: [] as string[],
    approvalTools: [] as string[],
    consentRequiredTools: [],
    approvalSpendCents: null as number | null,
    approvalExpiresAfterHours: null as number | null,
    budgets: {
      ...budgetDefaults,
      dailyRequests: 12,
      monthlyRequests: 12,
      dailySpendCents: 1,
      monthlySpendCents: 1,
    },
    globalPaused: false,
    usage: {
      // Stage reservation filled both request and spend caps for the day/month.
      spendMicros: BigInt(10_000),
      requests: 12,
      outboundActions: 0,
      month: { spendMicros: BigInt(10_000), requests: 12, outboundActions: 0 },
      activeRuns: 0,
    },
  };
  expect(
    evaluateActionForTest(saturated, {
      type: LOAD_SKILL_TOOL,
      readOnly: true,
      idempotencyKey: 'skill-no-extra-request',
    }).decision,
  ).toBe('allow');
  expect(
    evaluateCandidate(
      { ...policy, ...saturated },
      {
        type: mcpToolId('crm', 'search'),
        readOnly: true,
        idempotencyKey: 'mcp-no-extra-request',
      },
      null,
      true,
    ).decision,
  ).toBe('allow');
  // Unrelated read-only tools still see the filled spend reservation.
  expect(
    evaluateActionForTest(saturated, {
      type: 'knowledge.search',
      readOnly: true,
      idempotencyKey: 'other-read-only',
    }).decision,
  ).toBe('deny');
});

test('tool-step limit for proposals counts invocations, not inference stages', async () => {
  const { checkToolStepLimit } = await import('@/lib/budgets');
  // Nine tool calls + two model stages must not trip a limit of ten.
  expect(checkToolStepLimit(9, budgetDefaults)).toBeNull();
  expect(checkToolStepLimit(2 + 9, budgetDefaults)).toBe('tool-steps');
  expect(checkToolStepLimit(11, budgetDefaults)).toBe('tool-steps');
});
