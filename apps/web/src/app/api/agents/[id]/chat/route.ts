import { revalidatePath } from 'next/cache';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { z } from 'zod';

import { checkOrigin, getAdminEmail } from '@/lib/auth';
import { recipientId } from '@/lib/policy/scopes';
import {
  createPlaygroundStreamProgress,
  lastUserText,
  playgroundChunksFromResult,
} from '@/lib/runtime/chat-ui';
import { enqueueSimulation } from '@/lib/runtime/execute';
import { isTerminalSimulationStatus } from '@/lib/runtime/simulation-watch';
import { watchSimulationRun } from '@/lib/server/playground-queries';

export const maxDuration = 180;
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  messages: z.array(z.unknown()).min(1),
  configurationId: z.uuid(),
  recipients: z.array(recipientId).max(2).optional().default([]),
});

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
      let sawRun = false;

      for await (const run of watchSimulationRun(runId, { signal: request.signal })) {
        if (request.signal.aborted) {
          writer.write({ type: 'abort', reason: 'client disconnected' });
          return;
        }

        if (!run) {
          writer.write({ type: 'error', errorText: 'Run disappeared before completion.' });
          writer.write({ type: 'finish', finishReason: 'error' });
          return;
        }

        sawRun = true;
        const chunks = playgroundChunksFromResult(run.result, progress, {
          status: run.status,
          runId: run.id,
        });
        for (const chunk of chunks) {
          writer.write(chunk);
        }

        if (isTerminalSimulationStatus(run.status)) {
          return;
        }
      }

      if (request.signal.aborted) {
        writer.write({ type: 'abort', reason: 'client disconnected' });
        return;
      }

      if (!sawRun) {
        writer.write({ type: 'error', errorText: 'Run disappeared before completion.' });
        writer.write({ type: 'finish', finishReason: 'error' });
        return;
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
