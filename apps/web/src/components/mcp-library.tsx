'use client';

import { useState, useTransition } from 'react';
import { Plus } from 'lucide-react';

import { removeMcpConnection } from '@/actions/mcp';
import { LibraryEmpty, LibraryPageHeading, LibraryTable } from '@/components/library-table';
import { McpConnectionForm } from '@/components/mcp-connection-form';
import { emptyMcpEditor, type McpEditorState } from '@/components/mcp-editor-state';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SubmitButton } from '@/components/ui/submit-button';
import { formatUtcTimestamp } from '@/lib/format';

export interface McpListItem {
  id: string;
  name: string;
  url: string;
  transport: 'http' | 'sse';
  toolAllowlist: string[] | null;
  hasHeaders: boolean;
  agentCount: number;
  updatedAt: string;
}

export function McpLibrary({ items }: { items: McpListItem[] }) {
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<McpEditorState>(emptyMcpEditor);
  const [pending, startTransition] = useTransition();

  function openCreate() {
    setEditor(emptyMcpEditor());
    setOpen(true);
  }

  function openEdit(connection: McpListItem) {
    setEditor({
      connectionId: connection.id,
      name: connection.name,
      url: connection.url,
      transport: connection.transport,
      tools: connection.toolAllowlist ?? [],
      headers: [{ id: crypto.randomUUID(), key: '', value: '' }],
      clearHeaders: false,
      hasHeaders: connection.hasHeaders,
      discovered: connection.toolAllowlist ?? [],
    });
    setOpen(true);
  }

  return (
    <>
      <LibraryPageHeading
        title="MCP connections"
        description={
          <>
            Remote HTTP or SSE MCP servers. Auth headers are encrypted at rest and never shown back.
            Agents opt in from Access; every tool call still passes the policy gateway.
          </>
        }
        action={
          <Button type="button" onClick={openCreate}>
            <Plus size={16} aria-hidden="true" />
            New connection
          </Button>
        }
      />

      {!items.length ? (
        <LibraryEmpty
          title="No MCP connections yet"
          description="Register a shared HTTP or SSE server, choose which tools agents may see, then attach the connection from Access."
          action={
            <Button type="button" onClick={openCreate}>
              <Plus size={16} aria-hidden="true" />
              New connection
            </Button>
          }
        />
      ) : (
        <LibraryTable columns={['Connection', 'Agents', 'Updated']}>
          {items.map((connection) => (
            <tr key={connection.id}>
              <td>
                <div className="library-primary">{connection.name}</div>
                <div className="library-secondary">
                  {connection.transport.toUpperCase()} · {connection.url}
                  {connection.hasHeaders ? ' · Headers set' : ''}
                  {connection.toolAllowlist?.length
                    ? ` · ${connection.toolAllowlist.length} tool${connection.toolAllowlist.length === 1 ? '' : 's'}`
                    : ' · All tools'}
                </div>
              </td>
              <td>
                <span className="library-meta">
                  {connection.agentCount} agent{connection.agentCount === 1 ? '' : 's'}
                </span>
              </td>
              <td>
                <span className="library-meta">
                  {formatUtcTimestamp(new Date(connection.updatedAt))}
                </span>
              </td>
              <td>
                <div className="library-actions">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      openEdit(connection);
                    }}
                  >
                    Edit
                  </Button>
                  <form
                    action={(data) => {
                      startTransition(async () => {
                        await removeMcpConnection(data);
                      });
                    }}
                  >
                    <input type="hidden" name="connectionId" value={connection.id} />
                    <SubmitButton variant="destructive" size="sm" pendingLabel="Deleting…">
                      Delete
                    </SubmitButton>
                  </form>
                </div>
              </td>
            </tr>
          ))}
        </LibraryTable>
      )}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
        }}
      >
        <DialogContent className="library-dialog" showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>{editor.connectionId ? 'Edit connection' : 'New connection'}</DialogTitle>
            <DialogDescription>
              Auth header values are write-only. Existing secrets are never shown back.
            </DialogDescription>
          </DialogHeader>
          <McpConnectionForm
            editor={editor}
            setEditor={setEditor}
            pending={pending}
            startTransition={startTransition}
            onCancel={() => {
              setOpen(false);
            }}
            onSaved={() => {
              setOpen(false);
              setEditor(emptyMcpEditor());
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
