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
