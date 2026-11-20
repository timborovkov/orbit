'use client';

import { useId, useState, useTransition } from 'react';
import { CalendarClock, ChevronDown } from 'lucide-react';

import { cancelAgentFollowUp, scheduleAgentFollowUp } from '@/actions/follow-ups';
import { WorkspaceField } from '@/app/workspace-field';
import { WorkspaceForm } from '@/app/workspace-form';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatUtcTimestamp } from '@/lib/format';
import { localDatetimeToOffsetIso } from '@/lib/runtime/follow-ups/due';
import { followUpStatusLabels, type FollowUpStatus } from '@/lib/runtime/follow-ups/types';

export interface FollowUpRow {
  id: string;
  subject: string;
  note: string;
  dueAt: Date;
  status: FollowUpStatus;
  attempts: number;
  createdBy: string;
  source: string;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  finishedAt: Date | null;
  outcome: string | null;
  outcomeKind: string | null;
  jobStatus: string | null;
  jobAvailableAt: Date | null;
  createdAt: Date;
}

function toDatetimeLocalValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultDueLocal() {
  return toDatetimeLocalValue(new Date(Date.now() + 60 * 60 * 1000));
}

function CancelFollowUpButton({ agentId, followUpId }: { agentId: string; followUpId: string }) {
  const errorId = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="follow-up-cancel">
      {error ? (
        <FieldError className="form-error" id={errorId}>
          {error}
        </FieldError>
      ) : null}
      <Button
        type="button"
        variant="destructive"
        disabled={pending}
        aria-describedby={error ? errorId : undefined}
        onClick={() => {
          startTransition(async () => {
            setError(null);
            const form = new FormData();
            form.set('agentId', agentId);
            form.set('followUpId', followUpId);
            const result = await cancelAgentFollowUp(form);
            if (result.error) setError(result.error);
          });
        }}
      >
        {pending ? 'Cancelling…' : 'Cancel follow-up'}
      </Button>
    </div>
  );
}

async function scheduleFollowUpWithUtcDue(form: FormData) {
  const local = form.get('dueLocal');
  if (typeof local !== 'string') return { error: 'Choose a valid due time.' };
  const iso = localDatetimeToOffsetIso(local);
  if (!iso) return { error: 'Choose a valid due time.' };
  form.set('dueAt', iso);
  form.delete('dueLocal');
  return scheduleAgentFollowUp(form);
}

export function FollowUpsWorkbench({ agentId, items }: { agentId: string; items: FollowUpRow[] }) {
  const formId = useId();
  const [dueDefault] = useState(defaultDueLocal);

  return (
    <div className="follow-ups-workbench">
      <section className="follow-ups-schedule" aria-labelledby="follow-ups-schedule-heading">
        <div className="editor-section-heading">
          <h2 id="follow-ups-schedule-heading">Schedule a follow-up</h2>
          <p className="muted">
            Durable commitments survive worker restarts. When due, Orbit records an internal outcome
            on the activity timeline — no external actions.
          </p>
        </div>
        <WorkspaceForm action={scheduleFollowUpWithUtcDue} label="Schedule follow-up">
          <input type="hidden" name="agentId" value={agentId} />
          <FieldGroup className="form-fields">
            <WorkspaceField
              id={`${formId}-subject`}
              name="subject"
              label="Subject"
              required
              maxLength={200}
              description="Short commitment the durable queue will record when due."
            />
            <Field>
              <FieldLabel htmlFor={`${formId}-due`}>
                Due
                <span className="field-required-mark" aria-hidden="true">
                  {' '}
                  *
                </span>
              </FieldLabel>
              <Input
                id={`${formId}-due`}
                name="dueLocal"
                type="datetime-local"
                required
                defaultValue={dueDefault}
                aria-describedby={`${formId}-due-hint`}
              />
              <FieldDescription id={`${formId}-due-hint`}>
                Converted to an offset-bearing UTC instant before save; claimed by the durable job
                queue.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${formId}-note`}>Note</FieldLabel>
              <Textarea
                id={`${formId}-note`}
                name="note"
                maxLength={2000}
                rows={3}
                placeholder="Optional context for the internal outcome"
                aria-describedby={`${formId}-note-hint`}
              />
              <FieldDescription id={`${formId}-note-hint`}>
                Plain-text context stored with the commitment. External sends stay suppressed.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </WorkspaceForm>
      </section>

      <section className="follow-ups-list" aria-labelledby="follow-ups-list-heading">
        <div className="editor-section-heading">
          <h2 id="follow-ups-list-heading">Follow-ups</h2>
          <p className="muted">Inspect status, attempts, cancellation and recorded outcomes.</p>
        </div>
        {!items.length && (
          <div className="follow-ups-empty">
            <CalendarClock size={24} aria-hidden="true" />
            <p>No follow-ups yet. Schedule one above.</p>
          </div>
        )}
        {items.map((item) => (
          <details key={item.id} className="follow-up-detail" id={`follow-up-${item.id}`}>
            <summary>
              <div>
                <span className="follow-up-title">{item.subject}</span>
                <time dateTime={item.dueAt.toISOString()}>
                  Due {formatUtcTimestamp(item.dueAt)}
                  {item.jobStatus ? ` · job ${item.jobStatus}` : ''}
                  {item.attempts > 0
                    ? ` · ${item.attempts} attempt${item.attempts === 1 ? '' : 's'}`
                    : ''}
                </time>
              </div>
              <span className="state-label">{followUpStatusLabels[item.status]}</span>
              <ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" />
            </summary>
            <dl className="follow-up-inspect">
              <div>
                <dt>Source</dt>
                <dd>{item.source}</dd>
              </div>
              <div>
                <dt>Created by</dt>
                <dd>{item.createdBy}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>
                  <time dateTime={item.createdAt.toISOString()}>
                    {formatUtcTimestamp(item.createdAt)}
                  </time>
                </dd>
              </div>
              {item.note ? (
                <div>
                  <dt>Note</dt>
                  <dd>{item.note}</dd>
                </div>
              ) : null}
              {item.outcome ? (
                <div>
                  <dt>Outcome</dt>
                  <dd>{item.outcome}</dd>
                </div>
              ) : null}
              {item.outcomeKind ? (
                <div>
                  <dt>Outcome kind</dt>
                  <dd>{item.outcomeKind}</dd>
                </div>
              ) : null}
              {item.finishedAt ? (
                <div>
                  <dt>Finished</dt>
                  <dd>
                    <time dateTime={item.finishedAt.toISOString()}>
                      {formatUtcTimestamp(item.finishedAt)}
                    </time>
                  </dd>
                </div>
              ) : null}
              {item.cancelReason ? (
                <div>
                  <dt>Cancel reason</dt>
                  <dd>
                    {item.cancelReason}
                    {item.cancelledBy ? ` (${item.cancelledBy})` : ''}
                  </dd>
                </div>
              ) : null}
            </dl>
            {item.status === 'scheduled' && (
              <CancelFollowUpButton agentId={agentId} followUpId={item.id} />
            )}
          </details>
        ))}
      </section>
    </div>
  );
}
