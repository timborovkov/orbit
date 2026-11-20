'use client';

import { useRef, useState, useTransition } from 'react';
import { MoreHorizontal, Pencil, Plus } from 'lucide-react';

import { removeMcpConnection } from '@/actions/mcp';
import { LibraryEmpty, LibraryPageHeading, LibraryTable } from '@/components/library-table';
import { McpConnectionForm } from '@/components/mcp-connection-form';
import { emptyMcpEditor, type McpEditorState } from '@/components/mcp-editor-state';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatShortTimestamp } from '@/lib/format';
import type { McpAllowedTool } from '@/lib/mcp-allowlist';

export interface McpListItem {
  id: string;
  name: string;
  url: string;
  transport: 'http' | 'sse';
  toolAllowlist: McpAllowedTool[] | null;
  hasHeaders: boolean;
  agentCount: number;
  updatedAt: string;
}

export function McpLibrary({ items }: { items: McpListItem[] }) {
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<McpEditorState>(emptyMcpEditor);
  const [pending, startTransition] = useTransition();
  const [deleting, setDeleting] = useState<McpListItem | null>(null);
  const [deletePending, startDelete] = useTransition();
  const slugRef = useRef<HTMLInputElement>(null);

  const dialogTrigger = useRef<HTMLElement | null>(null);

  function openCreate() {
    setEditor(emptyMcpEditor());
    setOpen(true);
  }

  function openEdit(connection: McpListItem) {
    const tools = connection.toolAllowlist ?? [];
    setEditor({
      connectionId: connection.id,
      name: connection.name,
      url: connection.url,
      transport: connection.transport,
      tools,
      headers: [{ id: crypto.randomUUID(), key: '', value: '' }],
      clearHeaders: false,
      hasHeaders: connection.hasHeaders,
      discovered: tools.map((tool) => tool.name),
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
          <Button
            type="button"
            onClick={(event) => {
              dialogTrigger.current = event.currentTarget;
              openCreate();
            }}
          >
            <Plus size={16} aria-hidden="true" />
            New connection
          </Button>
        }
      />

      {!items.length ? (
        <LibraryEmpty
          title="No MCP connections yet"
          description="Register a shared HTTP or SSE server, choose which tools agents may see, then attach the connection from Access."
        />
      ) : (
        <>
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
                  <span className="library-meta">{formatShortTimestamp(connection.updatedAt)}</span>
                </td>
                <td>
                  <div className="library-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${connection.name}`}
                      onClick={(event) => {
                        dialogTrigger.current = event.currentTarget;
                        openEdit(connection);
                      }}
                    >
                      <Pencil size={16} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDeleting(connection);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </LibraryTable>

          <ul className="library-card-list">
            {items.map((connection) => (
              <li key={connection.id} className="library-card">
                <div className="library-card-copy">
                  <div className="library-primary">{connection.name}</div>
                  <div className="library-secondary">
                    {connection.transport.toUpperCase()} · {connection.url}
                  </div>
                  <div className="library-meta">
                    {connection.agentCount} agent{connection.agentCount === 1 ? '' : 's'}
                    {connection.hasHeaders ? ' · Headers set' : ''}
                    {connection.toolAllowlist?.length
                      ? ` · ${connection.toolAllowlist.length} tools`
                      : ' · All tools'}{' '}
                    · {formatShortTimestamp(connection.updatedAt)}
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      id={`connection-actions-${connection.id}`}
                      aria-label={`Actions for ${connection.name}`}
                    >
                      <MoreHorizontal size={16} aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="library-menu">
                    <DropdownMenuItem
                      onSelect={() => {
                        dialogTrigger.current = document.getElementById(
                          `connection-actions-${connection.id}`,
                        );
                        openEdit(connection);
                      }}
                    >
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => {
                        setDeleting(connection);
                      }}
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        </>
      )}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
        }}
      >
        <DialogContent
          className="form-dialog form-dialog-medium"
          showCloseButton={!pending}
          onPointerDownOutside={(event) => {
            event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            dialogTrigger.current?.focus();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            slugRef.current?.focus({ preventScroll: true });
          }}
        >
          <DialogHeader className="form-dialog-header">
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
            slugRef={slugRef}
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

      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(next) => {
          if (deletePending) return;
          if (!next) setDeleting(null);
        }}
      >
        <AlertDialogContent className="library-alert-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete connection?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete “{deleting?.name}”? Attached agents lose these tools on their next run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={deletePending || !deleting}
              onClick={() => {
                const connection = deleting;
                if (!connection) return;
                startDelete(async () => {
                  const data = new FormData();
                  data.set('connectionId', connection.id);
                  await removeMcpConnection(data);
                  setDeleting(null);
                });
              }}
            >
              {deletePending ? 'Deleting…' : 'Delete'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
