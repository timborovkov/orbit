'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { MoreHorizontal, Pencil, Plus } from 'lucide-react';

import { removeSkill } from '@/actions/skills';
import { LibraryEmpty, LibraryPageHeading, LibraryTable } from '@/components/library-table';
import { SkillEditorForm } from '@/components/skill-editor-form';
import { emptySkillEditor, type SkillEditorState } from '@/components/skill-editor-state';
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
  const [deleting, setDeleting] = useState<SkillListItem | null>(null);
  const [deletePending, startDelete] = useTransition();
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const input = titleRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open, editor.skillId]);

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
        <>
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
                    v{skill.version} · {formatShortTimestamp(skill.updatedAt)}
                  </span>
                </td>
                <td>
                  <div className="library-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${skill.title}`}
                      onClick={() => {
                        openEdit(skill);
                      }}
                    >
                      <Pencil size={16} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDeleting(skill);
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
            {items.map((skill) => (
              <li key={skill.id} className="library-card">
                <div className="library-card-copy">
                  <div className="library-primary">{skill.title}</div>
                  <div className="library-secondary">{skill.description}</div>
                  <div className="library-meta">
                    {skill.name} · v{skill.version} · {skill.agentCount} agent
                    {skill.agentCount === 1 ? '' : 's'} · {formatShortTimestamp(skill.updatedAt)}
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Actions for ${skill.title}`}
                    >
                      <MoreHorizontal size={16} aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="library-menu">
                    <DropdownMenuItem
                      onSelect={() => {
                        openEdit(skill);
                      }}
                    >
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => {
                        setDeleting(skill);
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
          className="library-dialog flex max-h-[calc(100dvh-2rem)] w-[min(560px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
          showCloseButton={!pending}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            titleRef.current?.focus({ preventScroll: true });
          }}
        >
          <DialogHeader className="library-dialog-header">
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

      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(next) => {
          if (deletePending) return;
          if (!next) setDeleting(null);
        }}
      >
        <AlertDialogContent className="library-alert-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete skill?</AlertDialogTitle>
            <AlertDialogDescription>
              Delete “{deleting?.title}”? Attached agents lose access on their next run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={deletePending || !deleting}
              onClick={() => {
                const skill = deleting;
                if (!skill) return;
                startDelete(async () => {
                  const data = new FormData();
                  data.set('skillId', skill.id);
                  await removeSkill(data);
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
