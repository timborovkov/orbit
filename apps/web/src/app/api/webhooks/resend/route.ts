import { Webhook } from 'svix';

import { reportFailure } from '@/lib/observability/errors';
import { readEmailPayload } from '@/lib/runtime/email/provider';
import { inboundWebhookSecret } from '@/lib/runtime/email/settings';
import {
  inboundEmailConfigured,
  persistReceivedEmail,
  receivedEvent,
} from '@/lib/server/email-mutations';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const secret = inboundWebhookSecret(process.env.RESEND_WEBHOOK_SECRET);
  if (!secret || !inboundEmailConfigured()) return new Response(null, { status: 503 });
  const headers = {
    'svix-id': request.headers.get('svix-id') ?? '',
    'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
    'svix-signature': request.headers.get('svix-signature') ?? '',
  };
  let verified: unknown;
  try {
    const body = await readEmailPayload(request.body, 1024 * 1024);
    new Webhook(secret).verify(body, headers);
    verified = JSON.parse(body);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (
    !verified ||
    typeof verified !== 'object' ||
    !('type' in verified) ||
    typeof verified.type !== 'string'
  ) {
    return new Response(null, { status: 400 });
  }
  if (verified.type !== 'email.received') return new Response(null, { status: 200 });
  const event = receivedEvent.safeParse(verified);
  if (!event.success) return new Response(null, { status: 400 });
  try {
    await persistReceivedEmail(event.data);
    return new Response(null, { status: 200 });
  } catch {
    reportFailure('web.request');
    return new Response(null, { status: 503 });
  }
}
