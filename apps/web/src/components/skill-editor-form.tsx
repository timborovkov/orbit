'use client';

import { useId } from 'react';

import { saveSkill } from '@/actions/skills';
import type { SkillEditorState } from '@/components/skill-editor-state';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { renderMarkdownPreview } from '@/lib/markdown-preview';
import { slugifyTitle } from '@/lib/slug';
import { cn } from '@/lib/utils';

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
      className="library-form"
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
      {editor.skillId && <input type="hidden" name="skillId" value={editor.skillId} />}
      <FieldGroup className="gap-5">
        <div className="library-form-grid">
          <Field>
            <FieldLabel htmlFor={`${formId}-title`}>Title</FieldLabel>
            <FieldDescription>Shown in the catalogue and Access picker.</FieldDescription>
            <Input
              ref={titleRef}
              id={`${formId}-title`}
              name="title"
              required
              maxLength={120}
              disabled={pending}
              value={editor.title}
              className="library-field-control"
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
            <FieldDescription>Stable id used by load_skill.</FieldDescription>
            <Input
              id={`${formId}-name`}
              name="name"
              required
              maxLength={80}
              pattern="^[a-z0-9][a-z0-9_-]{0,79}$"
              disabled={pending}
              value={editor.name}
              className="library-field-control"
              onChange={(event) => {
                setEditor((previous) => ({
                  ...previous,
                  name: event.target.value,
                  slugManual: true,
                }));
              }}
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor={`${formId}-description`}>When to use</FieldLabel>
          <FieldDescription>
            Short guidance the model sees before loading the body.
          </FieldDescription>
          <Textarea
            id={`${formId}-description`}
            name="description"
            required
            maxLength={500}
            rows={2}
            disabled={pending}
            value={editor.description}
            className="library-field-control"
            onChange={(event) => {
              setEditor((previous) => ({
                ...previous,
                description: event.target.value,
              }));
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="skill-body">Markdown body</FieldLabel>
          <FieldDescription>Write the full skill, then preview the rendering.</FieldDescription>
          <input type="hidden" name="body" value={editor.body} />
          <Tabs defaultValue="write" className="markdown-editor">
            <TabsList className="markdown-tabs" variant="line">
              <TabsTrigger value="write">Write</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
            </TabsList>
            <TabsContent value="write">
              <Textarea
                id="skill-body"
                maxLength={100000}
                rows={12}
                disabled={pending}
                value={editor.body}
                className={cn('library-field-control')}
                onChange={(event) => {
                  setEditor((previous) => ({ ...previous, body: event.target.value }));
                }}
              />
            </TabsContent>
            <TabsContent value="preview">
              <div
                className="markdown-preview"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdownPreview(editor.body || '_Nothing to preview yet._'),
                }}
              />
            </TabsContent>
          </Tabs>
        </Field>
      </FieldGroup>
      {editor.error && (
        <p role="alert" className="form-error">
          {editor.error}
        </p>
      )}
      <div className="library-footer">
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
