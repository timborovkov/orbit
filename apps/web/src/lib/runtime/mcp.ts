import { createHash } from 'node:crypto';

import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import type { Tool } from 'ai';

import {
  type McpAllowedTool,
  type McpToolAllowlistJson,
  mcpToolId,
  mcpToolIsReadOnly,
  normalizeMcpAllowlist,
} from '@/lib/mcp-allowlist';
import { authorizeAction, type CandidateAction, type PolicyContext } from '@/lib/policy/gateway';
import { decryptSecret } from '@/lib/runtime/secrets';
import type { ToolCallRecord } from '@/lib/runtime/skills';
import type { ToolStepGate } from '@/lib/runtime/tool-steps';
import type { McpTransport } from '@/lib/schema';

export interface McpConnectionConfig {
  id: string;
  name: string;
  url: string;
  transport: McpTransport;
  encryptedHeaders: string | null;
  /** Structured allowlist, or legacy `string[]` (normalized at load). */
  toolAllowlist: McpToolAllowlistJson | McpAllowedTool[] | null;
  grantedTools: string[];
}

export interface McpConnectionStatus {
  connectionId: string;
  name: string;
  status: 'ready' | 'error';
  error?: string;
  tools: string[];
}

/**
 * Model-facing tool key for OpenAI-compatible providers (letters, digits, `_`, `-`, ≤64).
 * Always suffixes a digest of the canonical pair so aliases stay unique across connections
 * (e.g. `a_b`/`c` vs `a`/`b_c`). Canonical `mcpToolId` stays on authorizeAction / audit.
 */
export function mcpToolAlias(connectionName: string, toolName: string) {
  const sanitize = (value: string) =>
    value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const left = sanitize(connectionName) || 'conn';
  const right = sanitize(toolName) || 'tool';
  const prefix = 'mcp_';
  const digest = createHash('sha256')
    .update(`${connectionName}\0${toolName}`)
    .digest('hex')
    .slice(0, 6);
  const suffix = `_${digest}`;
  const budget = 64 - prefix.length - suffix.length;
  const head = `${left}_${right}`.slice(0, Math.max(1, budget));
  return `${prefix}${head}${suffix}`;
}

export function mcpHeadersFromRows(rows: { key: string; value: string }[]) {
  const entries = rows.flatMap(({ key, value }) => {
    const trimmed = value.trim();
    return trimmed ? [[key, trimmed] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export const mcpEndpointHeaderError =
  'Replace or clear stored headers before changing the MCP endpoint.';

export function sameMcpEndpoint(
  saved: { url: string; transport: McpTransport },
  draft: { url: string; transport: McpTransport },
) {
  return (
    saved.transport === draft.transport && URL.parse(saved.url)?.href === URL.parse(draft.url)?.href
  );
}

/** Decrypt stored MCP auth headers. Never return ciphertext or secrets to the browser. */
export function decodeMcpHeaders(connectionId: string, encryptedHeaders: string | null) {
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
  const headers = decodeMcpHeaders(connection.id, connection.encryptedHeaders);
  if (connection.encryptedHeaders && !headers)
    throw new Error('Stored MCP headers are unavailable.');
  return await openMcpClient(
    {
      ...connection,
      headers,
    },
    signal,
  );
}

export function mcpDiscoverySignal(signal?: AbortSignal, timeoutMs = 30_000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function openMcpClient(
  connection: { url: string; transport: McpTransport; headers?: Record<string, string> },
  signal?: AbortSignal,
) {
  return await createMCPClient({
    transport: {
      type: connection.transport,
      url: connection.url,
      headers: connection.headers,
      redirect: 'error',
      fetch: Object.assign(
        (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (init?.method !== 'DELETE') return fetch(input, init);
          // Legacy Streamable HTTP terminates the session with a separate DELETE.
          const timeout = AbortSignal.timeout(2_000);
          const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
          return fetch(input, { ...init, signal });
        },
        fetch,
      ),
    },
    // Prefer classic initialize so admin-defined HTTP/SSE servers do not need
    // modern protocol discovery; discovery can be enabled later if required.
    protocolVersionDiscovery: false,
    initializationOptions: { signal: mcpDiscoverySignal(signal) },
  });
}

interface LoadedConnection {
  client?: MCPClient;
  status: McpConnectionStatus;
  tools: Record<string, Tool>;
}

/** List tools with a hard deadline; `client.tools()` does not accept AbortSignal. */
export async function listRemoteTools(client: MCPClient, signal?: AbortSignal) {
  const combined = mcpDiscoverySignal(signal);
  return await new Promise<Awaited<ReturnType<MCPClient['tools']>>>((resolve, reject) => {
    const onAbort = () => {
      reject(
        combined.reason instanceof Error ? combined.reason : new Error('MCP discovery aborted'),
      );
    };
    if (combined.aborted) {
      onAbort();
      return;
    }
    combined.addEventListener('abort', onAbort, { once: true });
    client.tools().then(
      (tools) => {
        combined.removeEventListener('abort', onAbort);
        resolve(tools);
      },
      (error: unknown) => {
        combined.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('MCP discovery failed'));
      },
    );
  });
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
    toolSteps?: ToolStepGate;
  },
): Promise<LoadedConnection> {
  let client: MCPClient | undefined;
  try {
    // Leave time for inference even when the agent uses the minimum run deadline.
    const signal = mcpDiscoverySignal(options.signal, 10_000);
    const allowlist = normalizeMcpAllowlist(connection.toolAllowlist);
    const registered: string[] = [];
    const tools: Record<string, Tool> = {};
    const grants = new Set(
      connection.grantedTools.filter((name) => mcpToolIsReadOnly(allowlist, name)),
    );
    if (grants.size) client = await options.connect(connection, signal);
    const remote = client ? await listRemoteTools(client, signal) : {};

    for (const [toolName, remoteTool] of Object.entries(remote)) {
      if (!grants.has(toolName)) continue;
      const capability = mcpToolId(connection.name, toolName);
      const alias = mcpToolAlias(connection.name, toolName);
      const originalExecute = remoteTool.execute;
      registered.push(toolName);
      // Register under the provider-safe alias; policy/audit still use `capability`.
      tools[alias] = {
        ...remoteTool,
        execute: async (input: unknown, execOptions) => {
          const args: Record<string, unknown> =
            input !== null && typeof input === 'object' && !Array.isArray(input)
              ? { ...(input as Record<string, unknown>) }
              : { value: input };

          if (options.toolSteps && !options.toolSteps.tryConsume()) {
            const record: ToolCallRecord = {
              tool: capability,
              args,
              policy: 'deny',
              result: null,
              error: 'Maximum tool steps for this run reached.',
            };
            await options.onCall?.(record);
            return { error: record.error };
          }

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
            mcp: {
              connectionId: connection.id,
              name: toolName,
              url: connection.url,
              transport: connection.transport,
            },
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

          let result: unknown;
          let error: string | undefined;
          try {
            result = await originalExecute(input, execOptions);
            if (
              result &&
              typeof result === 'object' &&
              'isError' in result &&
              result.isError === true
            ) {
              error = 'MCP tool execution failed.';
            }
          } catch {
            error = 'MCP tool execution failed.';
          }
          await options.onCall?.({
            tool: capability,
            args,
            policy: 'allow',
            result: error ? null : summariseToolResult(result),
            error,
          });
          return error ? { error } : result;
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
    if (client) {
      try {
        await client.close();
      } catch {
        // Best-effort; discovery already failed.
      }
    }
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
  toolSteps?: ToolStepGate;
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
        toolSteps: options.toolSteps,
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
