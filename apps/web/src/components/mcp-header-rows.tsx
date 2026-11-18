'use client';

import { Plus, X } from 'lucide-react';

import { newHeaderRow, type McpEditorState } from '@/components/mcp-editor-state';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export function McpHeaderRows({
  editor,
  setEditor,
  pending,
}: {
  editor: McpEditorState;
  setEditor: React.Dispatch<React.SetStateAction<McpEditorState>>;
  pending: boolean;
}) {
  return (
    <Field>
      <FieldLabel>Auth headers</FieldLabel>
      <FieldDescription>
        {editor.hasHeaders && !editor.clearHeaders
          ? 'Headers are already stored. Add rows with values to replace them, or clear them.'
          : 'Optional key/value pairs. Values are masked and encrypted at rest.'}
      </FieldDescription>
      {editor.hasHeaders && (
        <label className="resource-checkbox">
          <input
            type="checkbox"
            checked={editor.clearHeaders}
            disabled={pending}
            onChange={(event) => {
              setEditor((previous) => ({
                ...previous,
                clearHeaders: event.target.checked,
              }));
            }}
          />
          Clear stored headers
        </label>
      )}
      {!editor.clearHeaders && (
        <div className="kv-rows">
          {editor.headers.map((row, index) => (
            <div className="kv-row" key={row.id}>
              <Input
                aria-label={`Header ${index + 1} name`}
                placeholder="Authorization"
                disabled={pending}
                value={row.key}
                className="library-field-control"
                onChange={(event) => {
                  const key = event.target.value;
                  setEditor((previous) => ({
                    ...previous,
                    headers: previous.headers.map((item) =>
                      item.id === row.id ? { ...item, key } : item,
                    ),
                  }));
                }}
              />
              <Input
                aria-label={`Header ${index + 1} value`}
                placeholder={editor.hasHeaders ? '••••••••' : 'Bearer …'}
                type="password"
                autoComplete="off"
                disabled={pending}
                value={row.value}
                className="library-field-control"
                onChange={(event) => {
                  const value = event.target.value;
                  setEditor((previous) => ({
                    ...previous,
                    headers: previous.headers.map((item) =>
                      item.id === row.id ? { ...item, value } : item,
                    ),
                  }));
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove header ${index + 1}`}
                disabled={pending || editor.headers.length === 1}
                onClick={() => {
                  setEditor((previous) => ({
                    ...previous,
                    headers: previous.headers.filter((item) => item.id !== row.id),
                  }));
                }}
              >
                <X size={16} aria-hidden="true" />
              </Button>
            </div>
          ))}
          <div className="kv-add-row">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setEditor((previous) => ({
                  ...previous,
                  headers: [...previous.headers, newHeaderRow()],
                }));
              }}
            >
              <Plus size={14} aria-hidden="true" />
              Add header
            </Button>
          </div>
        </div>
      )}
    </Field>
  );
}
