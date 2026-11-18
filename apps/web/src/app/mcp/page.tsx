import { WorkspaceHeader } from '@/app/workspace-header';
import { McpLibrary } from '@/components/mcp-library';
import { env } from '@/lib/env';
import { listMcpConnections } from '@/lib/server/mcp-queries';

export const dynamic = 'force-dynamic';

export default async function McpConnectionsPage() {
  const { email, items } = await listMcpConnections();
  return (
    <div className="agent-shell">
      <WorkspaceHeader name="MCP connections" />
      <main className="agent-main">
        {env().AUTH_DISABLED && (
          <p className="local-auth-notice" role="status">
            Authentication disabled · Local development · {email}
          </p>
        )}
        <McpLibrary
          items={items.map((connection) => ({
            id: connection.id,
            name: connection.name,
            url: connection.url,
            transport: connection.transport,
            toolAllowlist: connection.toolAllowlist,
            hasHeaders: connection.hasHeaders,
            agentCount: connection.agentCount,
            updatedAt: connection.updatedAt.toISOString(),
          }))}
        />
      </main>
    </div>
  );
}
