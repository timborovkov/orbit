'use client';

import { useId, useState, useTransition } from 'react';

import Link from 'next/link';

import { ChevronDown } from 'lucide-react';

import { correctMemory, removeMemory } from '@/actions/memory';
import { WorkspaceForm } from '@/app/workspace-form';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatUtcTimestamp } from '@/lib/format';
import { memoryEvidenceHref, type MemoryRef } from '@/lib/runtime/memory/types';

type MemoryRow = MemoryRef & {
  subject: string;
  topic: string;
  fact: string;
  learnedAt: Date;
  expiresOn: string | null;
  reviewOn: string | null;
  correctedBy: string | null;
  correctedAt: Date | null;
  fromEmail: boolean;
};

function RemoveMemoryButton({ agentId, item }: { agentId: string; item: MemoryRow }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!pending) {
          setError(undefined);
          setOpen(value);
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="destructive">Remove memory</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this memory?</AlertDialogTitle>
          <AlertDialogDescription>
            The agent will no longer recall this entry. Its original source stays in Orbit.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                setError(undefined);
                const form = new FormData();
                form.set('agentId', agentId);
                form.set('id', item.id);
                form.set('revision', item.revision);
                try {
                  const result = await removeMemory(form);
                  if ('error' in result) setError(result.error);
                  else setOpen(false);
                } catch {
                  setError('Unable to remove memory. Try again.');
                }
              });
            }}
          >
            {pending ? 'Removing…' : 'Remove memory'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MemoryCorrection({ agentId, item }: { agentId: string; item: MemoryRow }) {
  const formId = useId();
  return (
    <WorkspaceForm action={correctMemory} label="Save correction">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="id" value={item.id} />
      <input type="hidden" name="revision" value={item.revision} />
      <FieldGroup className="form-fields">
        <Field>
          <FieldLabel htmlFor={`${formId}-fact`}>Fact or note</FieldLabel>
          <Textarea
            id={`${formId}-fact`}
            name="fact"
            rows={3}
            maxLength={500}
            required
            defaultValue={item.fact}
          />
        </Field>
        <div className="memory-dates">
          <Field>
            <FieldLabel htmlFor={`${formId}-expiry`}>Expires on (UTC)</FieldLabel>
            <Input
              id={`${formId}-expiry`}
              type="date"
              name="expiresOn"
              defaultValue={item.expiresOn ?? ''}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${formId}-review`}>Review on (UTC)</FieldLabel>
            <Input
              id={`${formId}-review`}
              type="date"
              name="reviewOn"
              defaultValue={item.reviewOn ?? ''}
            />
          </Field>
        </div>
      </FieldGroup>
    </WorkspaceForm>
  );
}

export function MemoryWorkbench({
  agentId,
  rows,
  page,
  hasMore,
  today,
}: {
  agentId: string;
  rows: MemoryRow[];
  page: number;
  hasMore: boolean;
  today: string;
}) {
  const href = (pageNumber: number) => `/agents/${agentId}?tab=memory&memoryPage=${pageNumber}`;
  return (
    <section className="memory-workbench" aria-labelledby="memory-heading">
      <div className="editor-section-heading">
        <h2 id="memory-heading">Memory</h2>
      </div>
      {rows.length === 0 && (
        <div className="follow-ups-empty">
          <p>
            {page === 1
              ? 'No memories yet. Facts learned from inbound messages and discovery appear here.'
              : 'No memories on this page.'}
          </p>
        </div>
      )}
      {rows.map((item) => {
        const status =
          item.expiresOn && item.expiresOn <= today
            ? 'Expired'
            : item.reviewOn && item.reviewOn <= today
              ? 'Review due'
              : 'Active';
        return (
          <details key={item.id} className="follow-up-detail memory-detail">
            <summary>
              <div>
                <span className="follow-up-title">
                  {item.subject} · {item.topic}
                </span>
                <span className="memory-fact preserve-text">{item.fact}</span>
                <time dateTime={item.learnedAt.toISOString()}>
                  Learned {formatUtcTimestamp(item.learnedAt)}
                </time>
              </div>
              <span className="state-label">{status}</span>
              <ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" />
            </summary>
            <div className="memory-detail-body">
              <dl className="follow-up-inspect">
                <div>
                  <dt>Source</dt>
                  <dd>
                    <Link href={memoryEvidenceHref(agentId, item)} className="memory-link">
                      {item.fromEmail ? 'View original message' : 'View original event'}
                    </Link>
                  </dd>
                </div>
                {item.correctedBy && item.correctedAt && (
                  <div>
                    <dt>Corrected</dt>
                    <dd>
                      {item.correctedBy} · {formatUtcTimestamp(item.correctedAt)}
                    </dd>
                  </div>
                )}
              </dl>
              <MemoryCorrection key={item.revision} agentId={agentId} item={item} />
              <RemoveMemoryButton agentId={agentId} item={item} />
            </div>
          </details>
        );
      })}
      {(page > 1 || hasMore) && (
        <nav className="email-pagination" aria-label="Memory pages">
          {page > 1 && (
            <Button asChild variant="outline">
              <Link href={href(page - 1)}>Newer entries</Link>
            </Button>
          )}
          {hasMore && (
            <Button asChild variant="outline">
              <Link href={href(page + 1)}>Older entries</Link>
            </Button>
          )}
        </nav>
      )}
    </section>
  );
}
