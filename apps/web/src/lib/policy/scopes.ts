import { z } from 'zod';

import { X_REPLY_ACTION } from '@/lib/runtime/x/reply-input';

export const proposalTypes = [
  'reply',
  'like',
  'repost',
  'follow',
  'bookmark',
  'introduce',
  'escalate',
] as const;
export const consentScope = z.enum(['introduce', 'escalate', X_REPLY_ACTION]);
export type ConsentScope = z.infer<typeof consentScope>;

// These are administrator-supplied scenario IDs, independent of provider input and model output.
export const recipientId = z.string().trim().min(1).max(120);
