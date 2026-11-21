'use client';

import { useId, useState, useTransition } from 'react';

import { Plus } from 'lucide-react';

import { createKnowledgeLibrary } from '@/actions/knowledge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export function NewKnowledgeLibrary() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fieldId = useId();
  const errorId = `${fieldId}-error`;

  function create(form: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await createKnowledgeLibrary(form);
        if (result.error) {
          setError(result.error);
          return;
        }
        setOpen(false);
      } catch {
        setError('Unable to create the library. Try again.');
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) {
          setName('');
          setError(null);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button">
          <Plus size={16} aria-hidden="true" />
          New library
        </Button>
      </DialogTrigger>
      <DialogContent
        className="form-dialog"
        showCloseButton={!pending}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="form-dialog-header">
          <DialogTitle>New library</DialogTitle>
          <DialogDescription>
            Name a collection of documents to share with agents.
          </DialogDescription>
        </DialogHeader>
        <form className="form-dialog-form" action={create}>
          <div className="form-dialog-body">
            <Field>
              <FieldLabel htmlFor={fieldId}>Name</FieldLabel>
              <Input
                id={fieldId}
                name="name"
                value={name}
                required
                maxLength={120}
                readOnly={pending}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              {error && (
                <p id={errorId} className="form-error" role="alert">
                  {error}
                </p>
              )}
            </Field>
          </div>
          <div className="form-dialog-footer">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? 'Creating…' : 'Create library'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
