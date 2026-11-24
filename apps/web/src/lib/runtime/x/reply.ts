import { and, eq } from 'drizzle-orm';

import type { Db, Tx } from '@/lib/db';
import type { ActionIntent, ChannelAction } from '@/lib/runtime/channels/types';
import { decryptSecret } from '@/lib/runtime/secrets';
import { xPostId, xReplyDraft, xReplyKey } from '@/lib/runtime/x/reply-input';
import { deliverXReply } from '@/lib/runtime/x/reply-provider';
import { X_PROVIDER } from '@/lib/runtime/x/types';
import { sourceEvents, xReplyCredentials } from '@/lib/schema';

export async function loadXReplyTarget(store: Db | Tx, agentId: string, runId: string) {
  const [event] = await store
    .select({
      postId: sourceEvents.providerEventId,
      authorId: sourceEvents.authorId,
      userId: xReplyCredentials.userId,
    })
    .from(sourceEvents)
    .leftJoin(xReplyCredentials, eq(xReplyCredentials.agentId, sourceEvents.agentId))
    .where(
      and(
        eq(sourceEvents.runId, runId),
        eq(sourceEvents.agentId, agentId),
        eq(sourceEvents.provider, X_PROVIDER),
      ),
    );
  if (
    !event?.authorId ||
    !xPostId.safeParse(event.authorId).success ||
    !xPostId.safeParse(event.postId).success
  )
    return null;
  return {
    postId: event.postId,
    authorId: event.authorId,
    userId: event.userId,
    recipient: `x:${event.authorId}`,
  };
}

export function xReplySecretSubject(agentId: string) {
  return `x-reply:${agentId}`;
}

export async function validateXReplyApproval(tx: Tx, intent: ActionIntent) {
  if (!xReplyDraft.safeParse(intent.payload.draft).success) {
    return 'Enter an X reply of 1 to 280 characters without additional mentions.';
  }
  const target = intent.runId && (await loadXReplyTarget(tx, intent.agentId, intent.runId));
  if (
    !target ||
    intent.recipients.length !== 1 ||
    intent.recipients[0] !== target.recipient ||
    intent.idempotencyKey !== xReplyKey(intent.agentId, target.postId)
  ) {
    return 'X replies require a matching discovery post and author.';
  }
}

export const prepareXReplyDelivery: ChannelAction['prepareDelivery'] = async (
  tx,
  outbound,
  intent,
) => {
  const error = await validateXReplyApproval(tx, intent);
  if (error) return { error };
  const target = intent.runId && (await loadXReplyTarget(tx, intent.agentId, intent.runId));
  if (!target) return { error: 'X discovery post is unavailable.' };
  const [connection] = await tx
    .select()
    .from(xReplyCredentials)
    .where(eq(xReplyCredentials.agentId, outbound.agentId));
  if (!connection) return { error: 'Connect an X user with write access before sending replies.' };
  if (intent.payload.xUserId !== connection.userId) {
    return { error: 'This proposal belongs to a different X connection.' };
  }
  const draft = xReplyDraft.safeParse(outbound.body);
  if (!draft.success) return { error: 'The saved X reply draft is invalid.' };
  let token: string;
  try {
    token = decryptSecret(xReplySecretSubject(outbound.agentId), connection.encryptedToken);
  } catch {
    return { error: 'The X user token could not be decrypted.' };
  }
  return {
    recipients: [target.recipient],
    send: (signal) =>
      deliverXReply({
        token,
        userId: connection.userId,
        authorId: target.authorId,
        postId: target.postId,
        text: draft.data,
        signal,
      }),
  };
};
