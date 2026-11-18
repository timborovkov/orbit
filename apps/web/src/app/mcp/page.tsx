import { Cable, ChevronDown } from 'lucide-react';

import { removeMcpConnection, saveMcpConnection } from '@/actions/mcp';
import { WorkspaceField, WorkspaceSelect } from '@/app/workspace-field';
import { WorkspaceForm } from '@/app/workspace-form';
import { WorkspaceHeader } from '@/app/workspace-header';
import { SubmitButton } from '@/components/ui/submit-button';
import { env } from '@/lib/env';
import { formatUtcTimestamp } from '@/lib/format';
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
        <div className="template-page-heading">
          <h1>MCP connections</h1>
          <p className="muted">
            Remote HTTP or SSE MCP servers. Auth headers are encrypted at rest and never shown back.
            Agents opt in from Access; every tool call still passes the policy gateway.
          </p>
        </div>

        <section className="surface resource-create" aria-labelledby="create-mcp-title">
          <div className="editor-section-heading">
            <h2 id="create-mcp-title">New connection</h2>
            <p className="muted">Register a shared MCP server, then attach it to agents.</p>
          </div>
          <WorkspaceForm action={saveMcpConnection} label="Create connection">
            <div className="resource-form-grid">
              <WorkspaceField id="new-mcp-name" name="name" label="Slug" required maxLength={80} />
              <WorkspaceSelect
                id="new-mcp-transport"
                name="transport"
                label="Transport"
                initialValue="http"
                options={[
                  { value: 'http', label: 'HTTP' },
                  { value: 'sse', label: 'SSE' },
                ]}
              />
            </div>
            <WorkspaceField id="new-mcp-url" name="url" label="URL" required maxLength={2000} />
            <WorkspaceField
              id="new-mcp-allowlist"
              name="toolAllowlist"
              label="Tool allowlist (optional)"
              multiline
              rows={2}
              maxLength={4000}
            />
            <p className="field-hint">
              Comma or newline separated tool names. Leave blank for all.
            </p>
            <WorkspaceField
              id="new-mcp-headers"
              name="headersText"
              label="Auth headers (optional)"
              multiline
              rows={3}
              maxLength={4000}
            />
            <p className="field-hint">One Header: value pair per line. Stored encrypted.</p>
          </WorkspaceForm>
        </section>

        <div className="template-list">
          {!items.length && (
            <div className="history-empty">
              <Cable size={24} aria-hidden="true" />
              <p>No MCP connections yet. Create one above.</p>
            </div>
          )}
          {items.map((connection) => (
            <details key={connection.id} className="template-row">
              <summary>
                <Cable size={18} aria-hidden="true" />
                <div>
                  <h2>{connection.name}</h2>
                  <p className="muted">
                    {connection.transport.toUpperCase()} · {connection.url}
                  </p>
                </div>
                <span className="state-label">
                  {connection.hasHeaders ? 'Headers set' : 'No headers'}
                </span>
                <ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" />
              </summary>
              <WorkspaceForm
                key={`${connection.id}-${connection.updatedAt.toISOString()}`}
                action={saveMcpConnection}
                label="Save connection"
                saveState
              >
                <input type="hidden" name="connectionId" value={connection.id} />
                <div className="resource-form-grid">
                  <WorkspaceField
                    id={`mcp-name-${connection.id}`}
                    name="name"
                    label="Slug"
                    required
                    maxLength={80}
                    initialValue={connection.name}
                  />
                  <WorkspaceSelect
                    id={`mcp-transport-${connection.id}`}
                    name="transport"
                    label="Transport"
                    initialValue={connection.transport}
                    options={[
                      { value: 'http', label: 'HTTP' },
                      { value: 'sse', label: 'SSE' },
                    ]}
                  />
                </div>
                <WorkspaceField
                  id={`mcp-url-${connection.id}`}
                  name="url"
                  label="URL"
                  required
                  maxLength={2000}
                  initialValue={connection.url}
                />
                <WorkspaceField
                  id={`mcp-allowlist-${connection.id}`}
                  name="toolAllowlist"
                  label="Tool allowlist (optional)"
                  multiline
                  rows={2}
                  maxLength={4000}
                  initialValue={connection.toolAllowlist?.join('\n') ?? ''}
                />
                <WorkspaceField
                  id={`mcp-headers-${connection.id}`}
                  name="headersText"
                  label="Replace auth headers"
                  multiline
                  rows={3}
                  maxLength={4000}
                />
                <p className="field-hint">
                  Leave blank to keep existing headers. Updated{' '}
                  {formatUtcTimestamp(connection.updatedAt)}.
                </p>
                <label className="resource-checkbox">
                  <input type="checkbox" name="clearHeaders" value="true" />
                  Clear stored headers
                </label>
              </WorkspaceForm>
              <form action={removeMcpConnection} className="resource-delete">
                <input type="hidden" name="connectionId" value={connection.id} />
                <SubmitButton variant="destructive" pendingLabel="Deleting…">
                  Delete connection
                </SubmitButton>
              </form>
            </details>
          ))}
        </div>
      </main>
    </div>
  );
}
