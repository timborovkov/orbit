'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Plus } from 'lucide-react';

import { removeSkill } from '@/actions/skills';
import { LibraryEmpty, LibraryPageHeading, LibraryTable } from '@/components/library-table';
import { SkillEditorForm } from '@/components/skill-editor-form';
import { emptySkillEditor, type SkillEditorState } from '@/components/skill-editor-state';
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

export interface SkillListItem {
  id: string;
  name: string;
  title: string;
  description: string;
  body: string;
  version: number;
  agentCount: number;
  updatedAt: string;
}

export function SkillsLibrary({ items }: { items: SkillListItem[] }) {
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<SkillEditorState>(emptySkillEditor);
  const [pending, startTransition] = useTransition();
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      const timer = window.setTimeout(() => titleRef.current?.focus(), 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [open]);

  function openCreate() {
    setEditor(emptySkillEditor());
    setOpen(true);
  }

  function openEdit(skill: SkillListItem) {
    setEditor({
      skillId: skill.id,
      name: skill.name,
      title: skill.title,
      description: skill.description,
      body: skill.body,
      slugManual: true,
    });
    setOpen(true);
  }

  return (
    <>
      <LibraryPageHeading
        title="Skills"
        description={
          <>
            Shared Markdown skills. Agents opt in from Access; prompts only receive names and
            descriptions until <code>load_skill</code> fetches a body.
          </>
        }
        action={
          <Button type="button" onClick={openCreate}>
            <Plus size={16} aria-hidden="true" />
            New skill
          </Button>
        }
      />

      {!items.length ? (
        <LibraryEmpty
          title="No skills yet"
          description={
            <>
              Create a reusable skill once, then attach it to any agent from Access. Bodies stay
              progressive until <code>load_skill</code> runs.
            </>
          }
          action={
            <Button type="button" onClick={openCreate}>
              <Plus size={16} aria-hidden="true" />
              New skill
            </Button>
          }
        />
      ) : (
        <LibraryTable columns={['Skill', 'Agents', 'Updated']}>
          {items.map((skill) => (
            <tr key={skill.id}>
              <td>
                <div className="library-primary">{skill.title}</div>
                <div className="library-secondary">
                  {skill.name} · {skill.description}
                </div>
              </td>
              <td>
                <span className="library-meta">
                  {skill.agentCount} agent{skill.agentCount === 1 ? '' : 's'}
                </span>
              </td>
              <td>
                <span className="library-meta">
                  v{skill.version} · {formatUtcTimestamp(new Date(skill.updatedAt))}
                </span>
              </td>
              <td>
                <div className="library-actions">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      openEdit(skill);
                    }}
                  >
                    Edit
                  </Button>
                  <form
                    action={(data) => {
                      startTransition(async () => {
                        await removeSkill(data);
                      });
                    }}
                  >
                    <input type="hidden" name="skillId" value={skill.id} />
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
            <DialogTitle>{editor.skillId ? 'Edit skill' : 'New skill'}</DialogTitle>
            <DialogDescription>
              {editor.skillId
                ? 'Saving content changes bumps the skill version for attached agents.'
                : 'Define a reusable skill once, then attach it to any agent.'}
            </DialogDescription>
          </DialogHeader>
          <SkillEditorForm
            editor={editor}
            setEditor={setEditor}
            pending={pending}
            startTransition={startTransition}
            titleRef={titleRef}
            onCancel={() => {
              setOpen(false);
            }}
            onSaved={() => {
              setOpen(false);
              setEditor(emptySkillEditor());
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
