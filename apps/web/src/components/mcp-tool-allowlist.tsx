'use client';

import { useState, useTransition } from 'react';
import { RefreshCw, X } from 'lucide-react';

import { discoverMcpTools } from '@/actions/mcp';
import type { HeaderRow, McpEditorState } from '@/components/mcp-editor-state';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { McpAllowedTool } from '@/lib/mcp-allowlist';

export function McpToolAllowlist({
  editor,
  setEditor,
  pending,
}: {
  editor: McpEditorState;
  setEditor: React.Dispatch<React.SetStateAction<McpEditorState>>;
  pending: boolean;
}) {
  const [toolDraft, setToolDraft] = useState('');
  const [fetching, startFetch] = useTransition();
  const selectedTools = new Set(editor.tools.map((tool) => tool.name));
  const discoveredTools = new Set(editor.discovered);
  const availableDiscovered = editor.discovered.filter((tool) => !selectedTools.has(tool));

  function addTool(name: string, readOnly = true) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setEditor((previous) => {
      if (previous.tools.some((tool) => tool.name === trimmed)) return previous;
      const next: McpAllowedTool = { name: trimmed, readOnly };
      return { ...previous, tools: [...previous.tools, next] };
    });
    setToolDraft('');
  }

  function toggleReadOnly(name: string) {
    setEditor((previous) => ({
      ...previous,
      tools: previous.tools.map((tool) =>
        tool.name === name ? { ...tool, readOnly: !tool.readOnly } : tool,
      ),
    }));
  }

  function fetchTools() {
    startFetch(async () => {
      setEditor((previous) => ({ ...previous, discoverError: undefined }));
      const result = await discoverMcpTools({
        url: editor.url,
        transport: editor.transport,
        connectionId: editor.connectionId,
        clearHeaders: editor.clearHeaders,
        headers: editor.headers.filter((row: HeaderRow) => row.key.trim() && row.value.trim()),
      });
      if ('error' in result) {
        setEditor((previous) => ({ ...previous, discoverError: result.error }));
        return;
      }
      setEditor((previous) => ({
        ...previous,
        discovered: result.tools,
      }));
    });
  }

  return (
    <Field>
      <FieldLabel>Tool allowlist</FieldLabel>
      <FieldDescription>
        Leave empty to register every discovered tool as mutating (suppressed until write adapters
        exist). Mark tools Read-only so the policy gateway can allow them. Remote annotations are
        ignored.
      </FieldDescription>
      <div className="chip-editor">
        {!!editor.tools.length && (
          <div className="chip-list" role="group" aria-label="Selected tools">
            {editor.tools.map((tool) => {
              const missing = discoveredTools.size > 0 && !discoveredTools.has(tool.name);
              const effect = tool.readOnly ? 'Read-only' : 'Mutating';
              return (
                <span
                  key={tool.name}
                  className="chip chip-selected"
                  title={
                    missing
                      ? 'Not in the last Fetch tools response; kept so the allowlist stays restrictive.'
                      : undefined
                  }
                >
                  <span className="chip-name">
                    {missing ? `${tool.name} · unavailable` : tool.name}
                  </span>
                  <button
                    type="button"
                    className="chip-effect"
                    disabled={pending}
                    aria-pressed={tool.readOnly}
                    aria-label={`${tool.name} effect: ${effect}. Click to toggle.`}
                    onClick={() => {
                      toggleReadOnly(tool.name);
                    }}
                  >
                    {effect}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${tool.name}`}
                    disabled={pending}
                    onClick={() => {
                      setEditor((previous) => ({
                        ...previous,
                        tools: previous.tools.filter((item) => item.name !== tool.name),
                      }));
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <div className="chip-add-row">
          <Input
            aria-label="Tool name"
            placeholder="tool_name"
            value={toolDraft}
            disabled={pending}
            className="library-field-control"
            onChange={(event) => {
              setToolDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addTool(toolDraft);
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={pending || !toolDraft.trim()}
            onClick={() => {
              addTool(toolDraft);
            }}
          >
            Add
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending || fetching || !editor.url}
            onClick={fetchTools}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {fetching ? 'Fetching…' : 'Fetch tools'}
          </Button>
        </div>
        {editor.discoverError && (
          <p role="alert" className="form-error">
            {editor.discoverError}
          </p>
        )}
        {!!availableDiscovered.length && (
          <div className="chip-list" role="group" aria-label="Available tools">
            {availableDiscovered.map((tool) => (
              <button
                key={tool}
                type="button"
                className="chip chip-choice"
                disabled={pending}
                aria-label={`Add ${tool}`}
                onClick={() => {
                  addTool(tool);
                }}
              >
                {tool}
              </button>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}
