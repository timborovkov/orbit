import { revalidatePath } from 'next/cache';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { checkOrigin, getAdminEmail } from '@/lib/auth';
import { db } from '@/lib/db';
import { recipientId } from '@/lib/policy/scopes';
import {
  createPlaygroundStreamProgress,
  lastUserText,
  playgroundChunksFromResult,
} from '@/lib/runtime/chat-ui';
import { enqueueSimulation } from '@/lib/runtime/execute';
import { runs } from '@/lib/schema';

export const maxDuration = 180;
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  messages: z.array(z.unknown()).min(1),
  configurationId: z.uuid(),
  recipients: z.array(recipientId).max(2).optional().default([]),
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await checkOrigin();
  } catch {
    return new Response('Invalid request origin', { status: 403 });
  }

  const actor = await getAdminEmail();
  if (!actor) return new Response('Unauthorized', { status: 401 });

  const { id: agentId } = await context.params;
  if (!z.uuid().safeParse(agentId).success) {
    return new Response('Not found', { status: 404 });
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return new Response('Invalid chat request', { status: 400 });
  }

  const input = lastUserText(parsed.messages as UIMessage[]);
  if (!input || input.length > 16000) {
    return new Response('Paste a post or question with 1–16,000 characters.', { status: 400 });
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: 'start' });

      const queued = await enqueueSimulation({
        actor,
        agentId,
        configurationId: parsed.configurationId,
        input,
        recipients: parsed.recipients,
      });

      if ('error' in queued && queued.error) {
        writer.write({ type: 'error', errorText: queued.error });
        writer.write({ type: 'finish', finishReason: 'error' });
        return;
      }

      const runId = 'runId' in queued ? queued.runId : undefined;
      if (!runId) {
        writer.write({ type: 'error', errorText: 'Failed to queue simulation.' });
        writer.write({ type: 'finish', finishReason: 'error' });
        return;
      }

      revalidatePath(`/agents/${agentId}`);

      writer.write({ type: 'text-start', id: 'status' });
      writer.write({
        type: 'text-delta',
        id: 'status',
        delta: 'Simulation queued. Waiting for the worker…',
      });
      writer.write({ type: 'text-end', id: 'status' });

      const progress = createPlaygroundStreamProgress();
      const started = Date.now();
      const deadlineMs = 150_000;

      while (Date.now() - started < deadlineMs) {
        if (request.signal.aborted) {
          writer.write({ type: 'abort', reason: 'client disconnected' });
          return;
        }

        const run = (await db().select().from(runs).where(eq(runs.id, runId))).at(0);
        if (!run) {
          writer.write({ type: 'error', errorText: 'Run disappeared before completion.' });
          writer.write({ type: 'finish', finishReason: 'error' });
          return;
        }

        const chunks = playgroundChunksFromResult(run.result, progress, {
          status: run.status,
          runId: run.id,
        });
        for (const chunk of chunks) {
          writer.write(chunk);
        }

        if (['completed', 'failed', 'interrupted'].includes(run.status)) {
          return;
        }

        await sleep(750);
      }

      writer.write({
        type: 'error',
        errorText: 'Timed out waiting for the worker. Check History for the run status.',
      });
      writer.write({ type: 'finish', finishReason: 'error' });
    },
    onError: () => 'Unable to stream the simulation result.',
  });

  return createUIMessageStreamResponse({ stream });
}
