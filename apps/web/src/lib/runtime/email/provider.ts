import { convert } from 'html-to-text';
import { z } from 'zod';

const receivedEmail = z.object({
  id: z.string(),
  message_id: z.string().nullish(),
  headers: z.record(z.string(), z.string()).nullish(),
  text: z.string().nullish(),
  html: z.string().nullish(),
});

export async function readEmailPayload(body: ReadableStream<Uint8Array> | null, maxBytes: number) {
  if (!body) throw new Error('Missing email payload');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error('Email payload exceeded the size limit');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function emailHeaderIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]);
  const tokens = bracketed.length ? bracketed : value.trim().split(/\s+/);
  return [
    ...new Set(
      tokens.filter((token) => /^[^<>\s@]+@[^<>\s@]+$/.test(token) && token.length <= 998),
    ),
  ].slice(-100);
}

export async function fetchReceivedEmail(
  emailId: string,
  apiKey: string | undefined,
  signal: AbortSignal,
) {
  if (!apiKey) throw new Error('Resend receiving key is unavailable');
  try {
    const response = await fetch(
      `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        redirect: 'error',
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Resend rejected the receive request');
    }
    const payload: unknown = JSON.parse(await readEmailPayload(response.body, 16 * 1024 * 1024));
    const email = receivedEmail.parse(payload);
    if (email.id !== emailId) throw new Error('Resend returned a different email');
    const headers = new Map(
      Object.entries(email.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const text = email.text?.trim() ?? '';
    const body =
      text ||
      (email.html
        ? convert(email.html.slice(0, 512_000), {
            wordwrap: false,
            selectors: [
              { selector: 'a', options: { ignoreHref: true } },
              { selector: 'img', format: 'skip' },
            ],
          })
        : '');
    return {
      body: body.replaceAll('\0', '').slice(0, 65_536),
      messageId:
        emailHeaderIds(headers.get('message-id')).at(0) ??
        emailHeaderIds(email.message_id).at(0) ??
        null,
      inReplyTo: emailHeaderIds(headers.get('in-reply-to')),
      referenceIds: emailHeaderIds(headers.get('references')),
    };
  } catch {
    // Provider exceptions and responses may contain the key, body, or private headers.
    throw new Error('Could not retrieve the inbound message from Resend');
  }
}
