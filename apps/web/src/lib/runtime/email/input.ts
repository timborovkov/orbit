import { z } from 'zod';

const emailInput = z.object({
  currentMessage: z.object({ body: z.string().optional(), subject: z.string() }),
});

export function emailKnowledgeQuery(input: string) {
  const decoded: unknown = JSON.parse(input);
  const { currentMessage } = emailInput.parse(decoded);
  const body = currentMessage.body?.trim() ?? '';
  return body || currentMessage.subject;
}

export function emailMemoryQuery(input: string) {
  try {
    const { currentMessage } = emailInput.parse(JSON.parse(input));
    return [currentMessage.subject, currentMessage.body].filter(Boolean).join('\n');
  } catch {
    // Older evaluation cases may carry plain text instead of a structured email.
    return input;
  }
}
