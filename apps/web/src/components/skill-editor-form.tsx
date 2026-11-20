'use client';

import { useId } from 'react';

import { saveSkill } from '@/actions/skills';
import { MarkdownEditor } from '@/components/markdown-editor';
import type { SkillEditorState } from '@/components/skill-editor-state';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { Textarea } from '@/components/ui/textarea';
import { slugifyTitle } from '@/lib/slug';

export function SkillEditorForm({
  editor,
  setEditor,
  pending,
  startTransition,
  titleRef,
  onCancel,
  onSaved,
}: {
  editor: SkillEditorState;
  setEditor: React.Dispatch<React.SetStateAction<SkillEditorState>>;
  pending: boolean;
  startTransition: React.TransitionStartFunction;
  titleRef: React.RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const formId = useId();

  return (
    <form
      id={formId}
      className="form-dialog-form"
      action={(data) => {
        startTransition(async () => {
          setEditor((previous) => ({ ...previous, error: undefined }));
          try {
            const result = await saveSkill(data);
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
      <div className="form-dialog-body">
        {editor.skillId && <input type="hidden" name="skillId" value={editor.skillId} />}
        <FieldGroup className="form-fields">
          <div className="form-grid">
            <Field>
              <FieldLabel htmlFor={`${formId}-title`}>Title</FieldLabel>
              <Input
                ref={titleRef}
                id={`${formId}-title`}
                name="title"
                required
                maxLength={120}
                disabled={pending}
                value={editor.title}
                onFocus={(event) => {
                  const input = event.currentTarget;
                  const end = input.value.length;
                  input.setSelectionRange(end, end);
                }}
                onChange={(event) => {
                  const title = event.target.value;
                  setEditor((previous) => ({
                    ...previous,
                    title,
                    name: previous.slugManual ? previous.name : slugifyTitle(title),
                  }));
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-name`}>Slug</FieldLabel>
              <Input
                id={`${formId}-name`}
                name="name"
                aria-describedby={`${formId}-name-hint`}
                required
                maxLength={80}
                pattern="[a-z0-9][a-z0-9_\-]{0,79}"
                disabled={pending}
                value={editor.name}
                onChange={(event) => {
                  setEditor((previous) => ({
                    ...previous,
                    name: event.target.value,
                    slugManual: true,
                  }));
                }}
              />
              <FieldDescription id={`${formId}-name-hint`}>
                Stable id used by load_skill.
              </FieldDescription>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor={`${formId}-description`}>When to use</FieldLabel>
            <Textarea
              id={`${formId}-description`}
              name="description"
              aria-describedby={`${formId}-description-hint`}
              required
              maxLength={500}
              rows={2}
              disabled={pending}
              value={editor.description}
              onChange={(event) => {
                setEditor((previous) => ({
                  ...previous,
                  description: event.target.value,
                }));
              }}
            />
            <FieldDescription id={`${formId}-description-hint`}>
              Short guidance the model sees before loading the body.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${formId}-body`}>Markdown body</FieldLabel>
            <MarkdownEditor
              id={`${formId}-body`}
              name="body"
              required
              large
              maxLength={100000}
              disabled={pending}
              value={editor.body}
              placeholder="# Instructions"
              onValueChange={(body) => {
                setEditor((previous) => ({ ...previous, body }));
              }}
            />
          </Field>
        </FieldGroup>
      </div>
      <div className="form-dialog-footer">
        {editor.error && (
          <p role="alert" className="form-error">
            {editor.error}
          </p>
        )}
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <SubmitButton disabled={pending} pendingLabel="Saving…">
          {editor.skillId ? 'Save skill' : 'Create skill'}
        </SubmitButton>
      </div>
    </form>
  );
}
