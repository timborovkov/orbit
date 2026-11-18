import { createHash } from 'node:crypto';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import type { Tool } from 'ai';

import { authorizeAction, type CandidateAction, type PolicyContext } from '@/lib/policy/gateway';
import { decryptSecret } from '@/lib/runtime/secrets';
import type { ToolCallRecord } from '@/lib/runtime/skills';
import type { McpTransport } from '@/lib/schema';

export interface McpConnectionConfig {
  id: string;
  name: string;
  url: string;
  transport: McpTransport;
  encryptedHeaders: string | null;
  toolAllowlist: string[] | null;
}

export interface McpConnectionStatus {
  connectionId: string;
  name: string;
  status: 'ready' | 'error';
  error?: string;
  tools: string[];
}

export function mcpToolId(connectionName: string, toolName: string) {
  return `mcp:${connectionName}:${toolName}`;
}

function decodeHeaders(connectionId: string, encryptedHeaders: string | null) {
  if (!encryptedHeaders) return undefined;
  try {
    const raw = decryptSecret(connectionId, encryptedHeaders);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && key.length && value.length) {
        headers[key] = value;
      }
    }
    return Object.keys(headers).length ? headers : undefined;
  } catch {
    return undefined;
  }
}

export async function connectMcpClient(
  connection: McpConnectionConfig,
  signal?: AbortSignal,
): Promise<MCPClient> {
  const headers = decodeHeaders(connection.id, connection.encryptedHeaders);
  return await createMCPClient({
    transport: {
      type: connection.transport,
      url: connection.url,
      headers,
    },
    // Prefer classic initialize so admin-defined HTTP/SSE servers do not need
    // modern protocol discovery; discovery can be enabled later if required.
    protocolVersionDiscovery: false,
    initializationOptions: signal ? { signal } : undefined,
  });
}

interface LoadedConnection {
  client?: MCPClient;
  status: McpConnectionStatus;
  tools: Record<string, Tool>;
}

async function loadOneConnection(
  connection: McpConnectionConfig,
  options: {
    policy: PolicyContext;
    executionToken?: string;
    signal?: AbortSignal;
    authorize: (
      ctx: PolicyContext,
      action: CandidateAction,
    ) => Promise<{
      decision: ToolCallRecord['policy'];
      reasons: string[];
      intentId?: string;
    }>;
    onCall?: (record: ToolCallRecord) => void | Promise<void>;
    connect: typeof connectMcpClient;
  },
): Promise<LoadedConnection> {
  try {
    const client = await options.connect(connection, options.signal);
    const remote = await client.tools();
    const allow = connection.toolAllowlist?.length ? new Set(connection.toolAllowlist) : null;
    const registered: string[] = [];
    const tools: Record<string, Tool> = {};

    for (const [toolName, remoteTool] of Object.entries(remote)) {
      if (allow && !allow.has(toolName)) continue;
      const capability = mcpToolId(connection.name, toolName);
      const originalExecute = remoteTool.execute;
      registered.push(toolName);
      tools[capability] = {
        ...remoteTool,
        execute: async (input: unknown, execOptions) => {
          const args: Record<string, unknown> =
            input !== null && typeof input === 'object' && !Array.isArray(input)
              ? { ...(input as Record<string, unknown>) }
              : { value: input };
          const idempotencyKey = createHash('sha256')
            .update(
              [
                options.policy.runId ?? 'none',
                capability,
                JSON.stringify(args),
                String(Date.now()),
              ].join(':'),
            )
            .digest('hex');
          const decision = await options.authorize(options.policy, {
            type: capability,
            readOnly: true,
            executionToken: options.executionToken,
            payload: args,
            idempotencyKey,
          });

          if (decision.decision !== 'allow') {
            const record: ToolCallRecord = {
              tool: capability,
              args,
              policy: decision.decision,
              result: null,
              error: decision.reasons.join(' '),
            };
            await options.onCall?.(record);
            return { error: decision.reasons.join(' ') || 'MCP tool denied by policy.' };
          }

          try {
            const result = await originalExecute(input, execOptions);
            const record: ToolCallRecord = {
              tool: capability,
              args,
              policy: 'allow',
              result: summariseToolResult(result),
            };
            await options.onCall?.(record);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'MCP tool execution failed.';
            const record: ToolCallRecord = {
              tool: capability,
              args,
              policy: 'allow',
              result: null,
              error: message,
            };
            await options.onCall?.(record);
            return { error: message };
          }
        },
      } as Tool;
    }

    return {
      client,
      tools,
      status: {
        connectionId: connection.id,
        name: connection.name,
        status: 'ready',
        tools: registered,
      },
    };
  } catch {
    return {
      tools: {},
      status: {
        connectionId: connection.id,
        name: connection.name,
        status: 'error',
        error: 'MCP connection failed. The agent run continues without this connection.',
        tools: [],
      },
    };
  }
}

/**
 * Register MCP tools for an agent run. Each tool execute path goes through the
 * policy gateway; connection failures degrade that connection only.
 */
export async function loadMcpToolsForAgent(options: {
  connections: McpConnectionConfig[];
  policy: PolicyContext;
  executionToken?: string;
  signal?: AbortSignal;
  authorize?: (
    ctx: PolicyContext,
    action: CandidateAction,
  ) => Promise<{
    decision: ToolCallRecord['policy'];
    reasons: string[];
    intentId?: string;
  }>;
  onCall?: (record: ToolCallRecord) => void | Promise<void>;
  connect?: typeof connectMcpClient;
}): Promise<{
  tools: Record<string, Tool>;
  statuses: McpConnectionStatus[];
  close: () => Promise<void>;
}> {
  const authorize = options.authorize ?? authorizeAction;
  const connect = options.connect ?? connectMcpClient;
  const loaded = await Promise.all(
    options.connections.map((connection) =>
      loadOneConnection(connection, {
        policy: options.policy,
        executionToken: options.executionToken,
        signal: options.signal,
        authorize,
        onCall: options.onCall,
        connect,
      }),
    ),
  );

  const tools: Record<string, Tool> = {};
  const statuses: McpConnectionStatus[] = [];
  const clients: MCPClient[] = [];
  for (const entry of loaded) {
    Object.assign(tools, entry.tools);
    statuses.push(entry.status);
    if (entry.client) clients.push(entry.client);
  }

  return {
    tools,
    statuses,
    close: async () => {
      await Promise.all(
        clients.map(async (client) => {
          try {
            await client.close();
          } catch {
            // Best-effort cleanup.
          }
        }),
      );
    },
  };
}

function summariseToolResult(result: unknown) {
  if (result === null || result === undefined) return null;
  if (typeof result === 'string') return { type: 'text', length: result.length };
  if (typeof result === 'object') {
    try {
      return { type: 'object', keys: Object.keys(result).slice(0, 20) };
    } catch {
      return { type: 'object' };
    }
  }
  return { type: typeof result };
}
