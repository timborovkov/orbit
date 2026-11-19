import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { authorizeAction, loadPolicyContext } from '@/lib/policy/gateway';
import { extractEmailAddress } from '@/lib/runtime/email/headers';
import { EMAIL_SEND_ACTION } from '@/lib/runtime/outbound/types';
import { draftAnswerFromResult, type SimulationResult } from '@/lib/runtime/simulation';
import { emailMessages } from '@/lib/schema';

/**
 * After an email draft run completes with an answer, open an `email.send`
 * proposal for administrator review. Destination and threading stay tied to
 * the inbound message id in the payload — never editable fields.
 */
export async function proposeEmailReplyFromDraft(input: {
  agentId: string;
  runId: string;
  actor: string;
  result: SimulationResult;
}): Promise<{ intentId: string } | null> {
  const draft = draftAnswerFromResult(input.result);
  if (!draft?.answer.trim()) return null;

  const message = (
    await db()
      .select({
        id: emailMessages.id,
        threadId: emailMessages.threadId,
        sender: emailMessages.sender,
      })
      .from(emailMessages)
      .where(and(eq(emailMessages.runId, input.runId), eq(emailMessages.agentId, input.agentId)))
      .limit(1)
  ).at(0);
  if (!message) return null;

  const recipient = extractEmailAddress(message.sender);
  if (!recipient) return null;

  const ctx = await loadPolicyContext(input.agentId, input.actor, input.runId);
  if (!ctx) return null;

  const decision = await authorizeAction(ctx, {
    type: EMAIL_SEND_ACTION,
    recipients: [recipient],
    payload: {
      draft: draft.answer,
      reason: 'Inbound email reply draft',
      emailMessageId: message.id,
      threadId: message.threadId,
    },
    idempotencyKey: `email.send:${message.id}`,
  });

  return { intentId: decision.intentId };
}
