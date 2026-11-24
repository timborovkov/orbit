import { z } from 'zod';

export const X_REPLY_ACTION = 'x.reply';
export const xPostId = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const xRecipientId = z.string().regex(/^x:[1-9][0-9]{0,18}$/);
export const xReplyDraftLength = 280;
export const xReplyDraft = z
  .string()
  .trim()
  .min(1)
  .max(xReplyDraftLength)
  .refine((draft) => !/@[a-z0-9_]/i.test(draft));
export const xUserAccessToken = z.string().trim().min(1).max(4096).regex(/^\S+$/);

export function xReplyKey(actorId: string, postId: string) {
  return `${X_REPLY_ACTION}:${actorId}:${postId}`;
}
