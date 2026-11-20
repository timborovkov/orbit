import { z } from 'zod';

import { readEmailPayload } from '@/lib/runtime/email/provider';

export interface OutboundEmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
  /** Stable key used to reconcile ambiguous provider responses. */
  idempotencyKey: string;
}

export type EmailSendOutcome =
  | { ok: true; id: string; raw: Record<string, unknown> }
  | { ok: false; retryable: boolean; error: string; raw?: Record<string, unknown> };

export interface EmailTransport {
  send(message: OutboundEmailMessage, signal: AbortSignal): Promise<EmailSendOutcome>;
}

const sendResponse = z.object({
  id: z.string().min(1).max(200),
});

/** Real Resend Emails API transport. Never log the API key or message body. */
export function createResendTransport(apiKey: string): EmailTransport {
  return {
    async send(message, signal) {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': message.idempotencyKey.slice(0, 256),
          },
          body: JSON.stringify({
            from: message.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            headers: message.headers,
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          redirect: 'error',
        });
        const payloadText = await readEmailPayload(response.body, 64 * 1024).catch(() => '');
        let raw: Record<string, unknown> = {};
        try {
          raw = payloadText ? (JSON.parse(payloadText) as Record<string, unknown>) : {};
        } catch {
          raw = { parseError: true };
        }
        if (response.ok) {
          const parsed = sendResponse.safeParse(raw);
          if (!parsed.success) {
            return {
              ok: false,
              retryable: true,
              error: 'Resend returned an ambiguous success response.',
              raw,
            };
          }
          return { ok: true, id: parsed.data.id, raw };
        }
        const retryable = response.status === 429 || response.status >= 500;
        return {
          ok: false,
          retryable,
          error: retryable
            ? 'Resend temporarily rejected the send request.'
            : 'Resend rejected the send request.',
          raw: { status: response.status },
        };
      } catch {
        return {
          ok: false,
          retryable: true,
          error: 'Could not reach Resend to send the email.',
        };
      }
    },
  };
}

/** In-memory stub for tests. Tracks calls for idempotency assertions. */
export function createStubEmailTransport(
  handler?: (message: OutboundEmailMessage) => Promise<EmailSendOutcome> | EmailSendOutcome,
): EmailTransport & { calls: OutboundEmailMessage[] } {
  const calls: OutboundEmailMessage[] = [];
  return {
    calls,
    async send(message) {
      calls.push(message);
      if (handler) return handler(message);
      return {
        ok: true,
        id: `stub_${calls.length}_${message.idempotencyKey.slice(0, 8)}`,
        raw: { id: `stub_${calls.length}` },
      };
    },
  };
}
