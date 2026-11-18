'use client';

import { useState, useTransition } from 'react';
import { RefreshCw, X } from 'lucide-react';

import { discoverMcpTools } from '@/actions/mcp';
import type { HeaderRow, McpEditorState } from '@/components/mcp-editor-state';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

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
  const selectedTools = new Set(editor.tools);

  function addTool(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setEditor((previous) => ({
      ...previous,
      tools: previous.tools.includes(trimmed) ? previous.tools : [...previous.tools, trimmed],
    }));
    setToolDraft('');
  }

  function fetchTools() {
    startFetch(async () => {
      setEditor((previous) => ({ ...previous, discoverError: undefined }));
      const result = await discoverMcpTools({
        url: editor.url,
        transport: editor.transport,
        headers: editor.headers.filter((row: HeaderRow) => row.key.trim() && row.value.trim()),
      });
      if ('error' in result) {
        setEditor((previous) => ({ ...previous, discoverError: result.error }));
        return;
      }
      const discovered = new Set(result.tools);
      setEditor((previous) => ({
        ...previous,
        discovered: result.tools,
        tools: previous.tools.length ? previous.tools.filter((tool) => discovered.has(tool)) : [],
      }));
    });
  }

  return (
    <Field>
      <FieldLabel>Tool allowlist</FieldLabel>
      <FieldDescription>
        Leave empty to expose every discovered tool. Fetch tools from the server, then add or remove
        names.
      </FieldDescription>
      <div className="chip-editor">
        {!!editor.tools.length && (
          <div className="chip-list" aria-live="polite">
            {editor.tools.map((tool) => (
              <span key={tool} className="chip">
                {tool}
                <button
                  type="button"
                  aria-label={`Remove ${tool}`}
                  disabled={pending}
                  onClick={() => {
                    setEditor((previous) => ({
                      ...previous,
                      tools: previous.tools.filter((item) => item !== tool),
                    }));
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            ))}
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
        {!!editor.discovered.length && (
          <div className="chip-list" aria-label="Discovered tools">
            {editor.discovered.map((tool) => {
              const selected = selectedTools.has(tool);
              return (
                <button
                  key={tool}
                  type="button"
                  className="chip"
                  disabled={pending || selected}
                  onClick={() => {
                    addTool(tool);
                  }}
                >
                  {selected ? `${tool} · added` : `+ ${tool}`}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Field>
  );
}
