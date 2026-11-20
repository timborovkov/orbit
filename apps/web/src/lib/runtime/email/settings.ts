import { z } from 'zod';

export const EMAIL_RECEIVE_JOB = 'email.receive';
export const EMAIL_DRAFT_JOB = 'email.draft';
export const EMAIL_ACTOR = 'system:inbound-email';

export { EMAIL_SEND_JOB } from '@/lib/runtime/outbound/types';

export function inboundEmailDomain(value: string | undefined) {
  const domain = value?.trim().toLowerCase();
  if (
    !domain ||
    domain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      domain,
    )
  ) {
    return;
  }
  return domain;
}

/** Optional verified sending domain; when set, mailbox From must match. */
export function sendingEmailDomain(value: string | undefined) {
  return inboundEmailDomain(value);
}

export function inboundWebhookSecret(value: string | undefined) {
  const secret = value?.trim();
  if (secret && /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return secret;
}

export const optionalResendApiKey = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).max(512).regex(/^\S+$/).optional(),
);
