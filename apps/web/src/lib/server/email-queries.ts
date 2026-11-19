import 'server-only';

import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { EMAIL_SEND_ACTION } from '@/lib/runtime/outbound/types';
import { draftAnswerFromResult } from '@/lib/runtime/simulation';
import {
  actionIntents,
  emailMailboxes,
  emailMessages,
  emailThreads,
  jobs,
  outboundActions,
  runs,
} from '@/lib/schema';
import { inboundEmailConfigured } from '@/lib/server/email-mutations';

const THREADS_PER_PAGE = 25;
const MESSAGES_PER_PAGE = 50;

const draftStatuses = {
  queued: 'Draft queued',
  running: 'Drafting',
  awaiting_approval: 'Awaiting approval',
  completed: 'No draft',
  failed: 'Failed',
  interrupted: 'Interrupted',
} satisfies Record<typeof runs.$inferSelect.status, string>;

const outboundLabels = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  blocked: 'Blocked',
} as const;

function receiveStatus(jobStatus: string | null, skipReason: string | null, waiting: boolean) {
  if (jobStatus === 'dead' || jobStatus === 'failed') return 'Failed';
  if (skipReason) return 'Skipped';
  if (jobStatus === 'cancelled') return 'Interrupted';
  if (waiting) return 'Waiting for capacity';
  return jobStatus === 'claimed' ? 'Retrieving message' : 'Queued';
}

export async function getEmailInbox(
  agentId: string,
  threadId: string | undefined,
  page: number,
  messagePage: number,
) {
  await requireAdmin();
  const store = db();
  const latest = store
    .selectDistinctOn([emailMessages.threadId], {
      id: emailMessages.threadId,
      subject: emailMessages.subject,
      sender: emailMessages.sender,
      receivedAt: emailMessages.receivedAt,
    })
    .from(emailMessages)
    .where(eq(emailMessages.agentId, agentId))
    .orderBy(asc(emailMessages.threadId), desc(emailMessages.receivedAt), desc(emailMessages.id))
    .as('latest_email');

  const [mailboxes, threadPage, selected, pending] = await Promise.all([
    store
      .select({ enabled: emailMailboxes.enabled, address: emailMailboxes.address })
      .from(emailMailboxes)
      .where(eq(emailMailboxes.agentId, agentId)),
    store
      .select()
      .from(latest)
      .orderBy(desc(latest.receivedAt), desc(latest.id))
      .offset((page - 1) * THREADS_PER_PAGE)
      .limit(THREADS_PER_PAGE + 1),
    threadId
      ? store
          .select({ id: emailThreads.id })
          .from(emailThreads)
          .where(and(eq(emailThreads.agentId, agentId), eq(emailThreads.id, threadId)))
      : [],
    store
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .leftJoin(jobs, eq(jobs.id, emailMessages.receiveJobId))
      .leftJoin(runs, and(eq(runs.id, emailMessages.runId), eq(runs.agentId, agentId)))
      .where(
        and(
          eq(emailMessages.agentId, agentId),
          or(
            inArray(jobs.status, ['pending', 'claimed']),
            inArray(runs.status, ['queued', 'running']),
          ),
        ),
      )
      .limit(1),
  ]);
  const threads = threadPage.slice(0, THREADS_PER_PAGE);
  const selectedId = selected.at(0)?.id ?? threads.at(0)?.id;
  const messages = selectedId
    ? await store
        .select({
          id: emailMessages.id,
          receivedAt: emailMessages.receivedAt,
          body: emailMessages.body,
          sender: emailMessages.sender,
          subject: emailMessages.subject,
          skipReason: emailMessages.skipReason,
          waitingForCapacity: emailMessages.waitingForCapacity,
          jobStatus: jobs.status,
          runStatus: runs.status,
          result: runs.result,
          deferReason: runs.deferReason,
          runId: emailMessages.runId,
        })
        .from(emailMessages)
        .leftJoin(jobs, eq(jobs.id, emailMessages.receiveJobId))
        .leftJoin(runs, and(eq(runs.id, emailMessages.runId), eq(runs.agentId, agentId)))
        .where(and(eq(emailMessages.agentId, agentId), eq(emailMessages.threadId, selectedId)))
        .orderBy(desc(emailMessages.receivedAt), desc(emailMessages.id))
        .offset((messagePage - 1) * MESSAGES_PER_PAGE)
        .limit(MESSAGES_PER_PAGE + 1)
    : [];

  const messageIds = messages.slice(0, MESSAGES_PER_PAGE).map((message) => message.id);
  const [intents, outbounds] = messageIds.length
    ? await Promise.all([
        store
          .select({
            id: actionIntents.id,
            reviewStatus: actionIntents.reviewStatus,
            decision: actionIntents.decision,
            draft: sql<string | null>`${actionIntents.payload}->>'draft'`,
            emailMessageId: sql<string | null>`${actionIntents.payload}->>'emailMessageId'`,
            reasons: actionIntents.reasons,
          })
          .from(actionIntents)
          .where(
            and(
              eq(actionIntents.agentId, agentId),
              eq(actionIntents.actionType, EMAIL_SEND_ACTION),
              sql`${actionIntents.payload}->>'emailMessageId' IN (${sql.join(
                messageIds.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            ),
          ),
        store
          .select({
            id: outboundActions.id,
            status: outboundActions.status,
            reason: outboundActions.reason,
            emailMessageId: outboundActions.emailMessageId,
            providerMessageId: outboundActions.providerMessageId,
            updatedAt: outboundActions.updatedAt,
          })
          .from(outboundActions)
          .where(
            and(
              eq(outboundActions.agentId, agentId),
              inArray(outboundActions.emailMessageId, messageIds),
            ),
          ),
      ])
    : [[], []];

  const intentByMessage = new Map(
    intents.flatMap((intent) =>
      intent.emailMessageId ? [[intent.emailMessageId, intent] as const] : [],
    ),
  );
  const outboundByMessage = new Map(
    outbounds.flatMap((row) => (row.emailMessageId ? [[row.emailMessageId, row] as const] : [])),
  );

  return {
    configured: inboundEmailConfigured(),
    mailbox: mailboxes.at(0),
    pending: pending.length > 0,
    threads,
    selectedId,
    hasOlderThreads: threadPage.length > THREADS_PER_PAGE,
    hasOlderMessages: messages.length > MESSAGES_PER_PAGE,
    messages: messages
      .slice(0, MESSAGES_PER_PAGE)
      .reverse()
      .map((message) => {
        const {
          jobStatus,
          runStatus,
          waitingForCapacity,
          deferReason,
          result,
          skipReason,
          runId: _runId,
          ...view
        } = message;
        const draft =
          runStatus === 'completed' &&
          result?.steps.some((step) => step.stage === 'main' && step.decision.relevant)
            ? draftAnswerFromResult(result)
            : null;
        const intent = intentByMessage.get(message.id);
        const outbound = outboundByMessage.get(message.id);
        const review =
          intent &&
          ({
            intentId: intent.id,
            status: intent.reviewStatus,
            draft: intent.draft ?? draft?.answer ?? null,
            decision: intent.decision,
            reasons: Array.isArray(intent.reasons) ? intent.reasons : [],
          } as const);
        const sendOutcome = outbound
          ? {
              status: outbound.status,
              label: outboundLabels[outbound.status],
              reason: outbound.reason,
              providerMessageId: outbound.providerMessageId,
            }
          : intent?.reviewStatus === 'approved' && intent.decision === 'allow'
            ? {
                status: 'queued' as const,
                label: outboundLabels.queued,
                reason: null as string | null,
                providerMessageId: null as string | null,
              }
            : intent?.reviewStatus === 'rejected'
              ? {
                  status: 'blocked' as const,
                  label: 'Rejected',
                  reason: 'Administrator rejected this reply.',
                  providerMessageId: null as string | null,
                }
              : null;
        const status = sendOutcome
          ? sendOutcome.label
          : intent?.reviewStatus === 'pending'
            ? 'Awaiting approval'
            : draft
              ? 'Draft ready'
              : runStatus
                ? draftStatuses[runStatus]
                : receiveStatus(jobStatus, skipReason, waitingForCapacity);
        return {
          ...view,
          status,
          detail:
            sendOutcome?.reason ??
            skipReason ??
            result?.error ??
            deferReason ??
            (status === 'Failed' ? 'Orbit could not process this inbound message.' : null),
          draft,
          review: review?.status === 'pending' ? review : review?.status ? review : null,
          sendOutcome,
        };
      }),
  };
}
