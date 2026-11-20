import { revalidatePath } from 'next/cache';

import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { z } from 'zod';

import { checkOrigin, getAdminEmail } from '@/lib/auth';
import { recipientId } from '@/lib/policy/scopes';
import {
  createPlaygroundStreamProgress,
  playgroundChunksFromResult,
  type PlaygroundUIMessage,
} from '@/lib/runtime/chat-ui';
import { enqueueSimulation } from '@/lib/runtime/execute';
import { isTerminalSimulationStatus } from '@/lib/runtime/simulation-watch';
import { watchSimulationRun } from '@/lib/server/playground-queries';

export const maxDuration = 180;
export const dynamic = 'force-dynamic';

const bodySchema = z.strictObject({
  input: z.string().trim().min(1).max(16000),
  configurationId: z.uuid(),
  recipients: z.array(recipientId).max(2),
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

  const stream = createUIMessageStream<PlaygroundUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: 'start' });

      const queued = await enqueueSimulation({ actor, agentId, ...parsed });

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

      writer.write({ type: 'data-run', data: { id: runId }, transient: true });

      const progress = createPlaygroundStreamProgress();

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

        const chunks = playgroundChunksFromResult(run.result, progress, {
          status: run.status,
          runId: run.id,
          deferReason: run.deferReason,
        });
        for (const chunk of chunks) {
          writer.write(chunk);
        }

        if (run.status === 'awaiting_approval') {
          writer.write({ type: 'data-approval', data: { runId: run.id } });
          writer.write({ type: 'finish', finishReason: 'stop' });
          return;
        }

        if (isTerminalSimulationStatus(run.status)) {
          return;
        }
      }

      if (request.signal.aborted) {
        writer.write({ type: 'abort', reason: 'client disconnected' });
        return;
      }

      writer.write({
        type: 'error',
        errorText: 'Stopped watching after the stream timed out. The run may still be processing.',
      });
      writer.write({ type: 'finish', finishReason: 'error' });
    },
    onError: () => 'Unable to stream the simulation result.',
  });

  return createUIMessageStreamResponse({ stream });
}
