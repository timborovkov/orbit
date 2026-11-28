import { and, eq, isNotNull } from 'drizzle-orm';

import type { ChannelAdapter } from '@/lib/runtime/channels/types';
import { extractEmailAddress } from '@/lib/runtime/email/headers';
import { emailKnowledgeQuery, emailMemoryQuery } from '@/lib/runtime/email/input';
import { EMAIL_DRAFT_JOB, EMAIL_RECEIVE_JOB } from '@/lib/runtime/email/settings';
import {
  EMAIL_INTRODUCTION_ACTION,
  EMAIL_SEND_ACTION,
  EMAIL_SEND_JOB,
} from '@/lib/runtime/outbound/types';
import { emailMailboxes, emailMessages } from '@/lib/schema';

export const emailChannel: ChannelAdapter = {
  id: 'email',
  label: 'Email',
  legacyOrigin: 'email',
  activity: { receivedLabel: 'Received email', sentLabel: 'Sent email reply' },
  run: {
    mode: 'draft',
    jobType: EMAIL_DRAFT_JOB,
    allowContentCapture: false,
    knowledgeQuery: emailKnowledgeQuery,
    recallQuery: emailMemoryQuery,
    async evaluationInput(tx, agentId, sourceId) {
      const [source] = await tx
        .select()
        .from(emailMessages)
        .where(and(eq(emailMessages.id, sourceId), eq(emailMessages.agentId, agentId)));
      if (!source) return null;
      const { buildEmailDraftInput } = await import('@/lib/runtime/email/receive');
      return buildEmailDraftInput(tx, source);
    },
    async complete(input) {
      const { proposeEmailReplyFromDraft } = await import('@/lib/runtime/email/propose');
      return proposeEmailReplyFromDraft(input);
    },
    async recover(input) {
      const { recoverEmailReplyProposalIfNeeded } = await import('@/lib/runtime/email/propose');
      return recoverEmailReplyProposalIfNeeded(input);
    },
  },
  followUp: {
    actionType: EMAIL_SEND_ACTION,
    async prepare(tx, anchor, commitment) {
      const [message] = await tx
        .select({ message: emailMessages })
        .from(emailMessages)
        .innerJoin(emailMailboxes, eq(emailMailboxes.agentId, emailMessages.agentId))
        .where(
          and(
            eq(emailMessages.id, anchor.anchorId),
            eq(emailMessages.agentId, anchor.agentId),
            eq(emailMessages.threadId, anchor.conversationId),
            eq(emailMailboxes.enabled, true),
            isNotNull(emailMessages.body),
          ),
        );
      if (!message) return null;
      const recipient = extractEmailAddress(message.message.sender);
      if (!recipient) return null;
      const { buildEmailDraftInput } = await import('@/lib/runtime/email/receive');
      return {
        input: await buildEmailDraftInput(tx, message.message, commitment),
        recipients: [recipient],
        payload: { emailMessageId: message.message.id, threadId: message.message.threadId },
      };
    },
  },
  actions: [
    {
      type: EMAIL_INTRODUCTION_ACTION,
      label: 'Email introductions',
      provider: 'resend',
      alwaysRequiresApproval: true,
      standalone: true,
      idempotencyWindowMs: 23 * 60 * 60 * 1000, // Resend retains keys for 24 hours.
      async validateApproval(tx, intent) {
        const { validateIntroductionApproval } = await import('@/lib/runtime/email/introduction');
        return validateIntroductionApproval(tx, intent);
      },
      async prepareDelivery(tx, outbound, intent) {
        const { prepareIntroductionDelivery } = await import('@/lib/runtime/email/introduction');
        return prepareIntroductionDelivery(tx, outbound, intent);
      },
    },
    {
      type: EMAIL_SEND_ACTION,
      jobType: EMAIL_SEND_JOB,
      provider: 'resend',
      alwaysRequiresApproval: true,
      usesProviderGrant: true,
      legacyReferences({ payload }) {
        return {
          emailMessageId:
            typeof payload.emailMessageId === 'string' ? payload.emailMessageId : null,
          threadId: typeof payload.threadId === 'string' ? payload.threadId : null,
        };
      },
      async validateApproval(tx, intent) {
        const { validateEmailApproval } = await import('@/lib/runtime/email/send');
        return validateEmailApproval(tx, intent);
      },
      async prepareDelivery(tx, outbound, intent) {
        const { prepareEmailDelivery } = await import('@/lib/runtime/email/send');
        return prepareEmailDelivery(tx, outbound, intent);
      },
    },
  ],
  jobs(workerId) {
    return {
      [EMAIL_RECEIVE_JOB]: async (job, signal) => {
        const [{ processEmailReceiveJob }, { fetchReceivedEmail }] = await Promise.all([
          import('@/lib/runtime/email/receive'),
          import('@/lib/runtime/email/provider'),
        ]);
        return processEmailReceiveJob(job, workerId, signal, (id, fetchSignal) =>
          fetchReceivedEmail(id, process.env.RESEND_API_KEY, fetchSignal),
        );
      },
    };
  },
};
