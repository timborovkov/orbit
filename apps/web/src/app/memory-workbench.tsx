'use client';

import { useId, useState, useTransition } from 'react';

import Link from 'next/link';

import { ChevronDown } from 'lucide-react';

import { configureMemoryRetention, correctMemory, removeMemory } from '@/actions/memory';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatUtcTimestamp } from '@/lib/format';
import {
  memoryEvidenceHref,
  type MemoryRef,
  type PersonMemoryField,
  personMemoryLabels,
} from '@/lib/runtime/memory/types';

type MemoryRow = MemoryRef & {
  subject: string;
  topic: string;
  fact: string;
  noteKind: string | null;
  personField: PersonMemoryField | null;
  personValue: string | null;
  personId: string | null;
  learnedAt: Date;
  expiresOn: string | null;
  reviewOn: string | null;
  correctedBy: string | null;
  correctedAt: Date | null;
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
          <FieldLabel htmlFor={`${formId}-fact`}>
            {item.personField ? personMemoryLabels[item.personField] : 'Fact or note'}
          </FieldLabel>
          {item.personField ? (
            <Input
              id={`${formId}-fact`}
              name="personValue"
              maxLength={120}
              required
              defaultValue={item.personValue ?? ''}
            />
          ) : (
            <Textarea
              id={`${formId}-fact`}
              name="fact"
              rows={3}
              maxLength={500}
              required
              defaultValue={item.fact}
            />
          )}
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

type RetentionSettings = {
  factDays: number | null;
  noteDays: number | null;
  outcomeDays: number | null;
  intervalDays: 1 | 7;
};

function RetentionForm({ agentId, retention }: { agentId: string; retention: RetentionSettings }) {
  const id = useId();
  const fields = [
    ['factDays', 'Facts'],
    ['noteDays', 'Notes'],
    ['outcomeDays', 'Outcomes'],
  ] as const;
  return (
    <details className="follow-up-detail">
      <summary>
        <span className="follow-up-title">Retention</span>
        <ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" />
      </summary>
      <div className="memory-detail-body">
        <WorkspaceForm action={configureMemoryRetention} label="Save retention">
          <input type="hidden" name="agentId" value={agentId} />
          <p className="muted" id={`${id}-days`}>
            Automatically remove older memories after this many days. Blank keeps entries until
            removed.
          </p>
          <FieldGroup className="memory-dates">
            {fields.map(([field, label]) => (
              <Field key={field}>
                <FieldLabel htmlFor={`${id}-${field}`}>{label} (days)</FieldLabel>
                <Input
                  id={`${id}-${field}`}
                  name={field}
                  type="number"
                  min={1}
                  max={3650}
                  defaultValue={retention[field] ?? ''}
                  aria-describedby={`${id}-days`}
                />
              </Field>
            ))}
            <Field>
              <FieldLabel htmlFor={`${id}-schedule`}>Maintenance schedule</FieldLabel>
              <Select name="intervalDays" defaultValue={String(retention.intervalDays)}>
                <SelectTrigger id={`${id}-schedule`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Daily</SelectItem>
                  <SelectItem value="7">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        </WorkspaceForm>
      </div>
    </details>
  );
}

export function MemoryWorkbench({
  agentId,
  rows,
  page,
  hasMore,
  today,
  retention,
}: {
  agentId: string;
  rows: MemoryRow[];
  page: number;
  hasMore: boolean;
  today: string;
  retention: RetentionSettings;
}) {
  const href = (pageNumber: number) => `/agents/${agentId}?tab=memory&memoryPage=${pageNumber}`;
  return (
    <section className="memory-workbench" aria-labelledby="memory-heading">
      <div className="editor-section-heading">
        <h2 id="memory-heading">Memory</h2>
      </div>
      <RetentionForm agentId={agentId} retention={retention} />
      {rows.length === 0 && (
        <div className="follow-ups-empty">
          <p>
            {page === 1
              ? 'No memories yet. Facts the agent learns during runs appear here.'
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
                  {item.noteKind ? ` · ${item.noteKind}` : ''}
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
                      View original source
                    </Link>
                  </dd>
                </div>
                {item.personId && (
                  <div>
                    <dt>Person</dt>
                    <dd>
                      <Link
                        href={`/people/${item.personId}?agent=${agentId}`}
                        className="memory-link"
                      >
                        View person
                      </Link>
                    </dd>
                  </div>
                )}
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
