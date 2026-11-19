'use client';

import { useId } from 'react';

import { saveMcpConnection } from '@/actions/mcp';
import { type McpEditorState } from '@/components/mcp-editor-state';
import { McpHeaderRows } from '@/components/mcp-header-rows';
import { McpToolAllowlist } from '@/components/mcp-tool-allowlist';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SubmitButton } from '@/components/ui/submit-button';

export function McpConnectionForm({
  editor,
  setEditor,
  pending,
  startTransition,
  slugRef,
  onCancel,
  onSaved,
}: {
  editor: McpEditorState;
  setEditor: React.Dispatch<React.SetStateAction<McpEditorState>>;
  pending: boolean;
  startTransition: React.TransitionStartFunction;
  slugRef: React.RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const formId = useId();

  return (
    <form
      id={formId}
      className="library-form"
      action={(data) => {
        startTransition(async () => {
          setEditor((previous) => ({ ...previous, error: undefined }));
          try {
            const result = await saveMcpConnection(data);
            if (result.error) {
              setEditor((previous) => ({ ...previous, error: result.error }));
              return;
            }
            onSaved();
          } catch {
            setEditor((previous) => ({
              ...previous,
              error: 'Unable to save. Check your connection and try again.',
            }));
          }
        });
      }}
    >
      <div className="library-dialog-body">
        {editor.connectionId && (
          <input type="hidden" name="connectionId" value={editor.connectionId} />
        )}
        <input type="hidden" name="transport" value={editor.transport} />
        <input type="hidden" name="toolAllowlist" value={JSON.stringify(editor.tools)} />
        <input
          type="hidden"
          name="headers"
          value={JSON.stringify(
            editor.clearHeaders
              ? []
              : editor.headers.filter((row) => row.key.trim() && row.value.trim()),
          )}
        />
        {editor.clearHeaders && <input type="hidden" name="clearHeaders" value="true" />}

        <FieldGroup className="gap-5">
          <div className="library-form-grid">
            <Field>
              <FieldLabel htmlFor={`${formId}-name`}>Slug</FieldLabel>
              <FieldDescription>Stable id used in tool names.</FieldDescription>
              <Input
                ref={slugRef}
                id={`${formId}-name`}
                name="name"
                required
                maxLength={80}
                pattern="^[a-z0-9][a-z0-9_-]{0,79}$"
                disabled={pending}
                value={editor.name}
                className="library-field-control"
                onFocus={(event) => {
                  const input = event.currentTarget;
                  const end = input.value.length;
                  input.setSelectionRange(end, end);
                }}
                onChange={(event) => {
                  setEditor((previous) => ({ ...previous, name: event.target.value }));
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-transport`}>Transport</FieldLabel>
              <FieldDescription>HTTP streamable or classic SSE.</FieldDescription>
              <Select
                value={editor.transport}
                onValueChange={(value) => {
                  setEditor((previous) => ({
                    ...previous,
                    transport: value as 'http' | 'sse',
                  }));
                }}
                disabled={pending}
              >
                <SelectTrigger
                  id={`${formId}-transport`}
                  className="library-select-trigger"
                  size="default"
                >
                  <SelectValue placeholder="Select transport" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="sse">SSE</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor={`${formId}-url`}>URL</FieldLabel>
            <FieldDescription>Remote MCP endpoint the worker will call.</FieldDescription>
            <Input
              id={`${formId}-url`}
              name="url"
              type="url"
              required
              maxLength={2000}
              disabled={pending}
              value={editor.url}
              className="library-field-control"
              onChange={(event) => {
                setEditor((previous) => ({ ...previous, url: event.target.value }));
              }}
            />
          </Field>

          <McpToolAllowlist editor={editor} setEditor={setEditor} pending={pending} />
          <McpHeaderRows editor={editor} setEditor={setEditor} pending={pending} />
        </FieldGroup>

        {editor.error && (
          <p role="alert" className="form-error">
            {editor.error}
          </p>
        )}
      </div>

      <div className="library-footer">
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <SubmitButton disabled={pending} pendingLabel="Saving…">
          {editor.connectionId ? 'Save connection' : 'Create connection'}
        </SubmitButton>
      </div>
    </form>
  );
}
