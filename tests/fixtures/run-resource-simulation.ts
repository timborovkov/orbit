import { closeDb } from '@/lib/db';
import { processSimulationJob } from '@/lib/runtime/execute';
import { openRouterInference } from '@/lib/runtime/openrouter';

const runId = process.argv[2];
if (!runId) throw new Error('The resource fixture needs a run ID');

const realFetch = globalThis.fetch;
const decision = {
  relevant: true,
  priority: 0.9,
  reason: 'Resource fixture',
  actions: [{ type: 'reply', reason: 'Fixture response', draft: null }],
};

// Only provider traffic is mocked. MCP still uses the actual transports and gateway.
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://openrouter.ai') return realFetch(input, init);
    const request = JSON.parse(String(init?.body));
    const toolCalls = request.messages.some((message: { role: string }) => message.role === 'tool')
      ? []
      : (request.tools ?? []).map(
          ({ function: tool }: { function: { name: string } }, index: number) => ({
            id: `fixture_${index}`,
            type: 'function',
            function: {
              name: tool.name,
              arguments: JSON.stringify(
                tool.name === 'load_skill' ? { name: 'release-check' } : {},
              ),
            },
          }),
        );
    return Response.json({
      id: 'resource_fixture',
      object: 'chat.completion',
      created: 1,
      model: request.model,
      choices: [
        {
          index: 0,
          message: toolCalls.length
            ? { role: 'assistant', content: null, tool_calls: toolCalls }
            : { role: 'assistant', content: JSON.stringify(decision) },
          finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0 },
    });
  },
  { preconnect: realFetch.preconnect },
);

try {
  await processSimulationJob({ runId }, openRouterInference);
} finally {
  globalThis.fetch = realFetch;
  await closeDb();
}
