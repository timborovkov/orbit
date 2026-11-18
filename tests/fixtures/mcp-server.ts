import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';

export const mcpFixtureAuthorization = 'Bearer local-mcp-fixture';

export async function startMcpFixture() {
  const streams = new Map<string, ServerResponse>();
  const calls: string[] = [];
  let nextSession = 0;
  const server = createServer(async (request, response) => {
    const path = request.url ?? '';
    if (request.headers.authorization !== mcpFixtureAuthorization) {
      response.writeHead(401).end();
      return;
    }
    if (path === '/sse' && request.method === 'GET') {
      const endpoint = `/messages/${++nextSession}`;
      streams.set(endpoint, response);
      response.on('close', () => streams.delete(endpoint));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`event: endpoint\ndata: ${endpoint}\n\n`);
      return;
    }
    const stream = streams.get(path);
    if ((!stream && path !== '/http') || request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const { id, method } = JSON.parse(body);
    if (id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const tool = stream ? 'sse_lookup' : 'http_lookup';
    let result: unknown;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        };
        break;
      case 'tools/list':
        result = { tools: [{ name: tool, inputSchema: { type: 'object', properties: {} } }] };
        break;
      case 'tools/call':
        calls.push(tool);
        result = { content: [{ type: 'text', text: `${tool} result` }] };
        break;
      default:
        response.writeHead(400).end();
        return;
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
    if (stream) {
      stream.write(`event: message\ndata: ${payload}\n\n`);
      response.writeHead(202).end();
    } else {
      response.writeHead(200, { 'content-type': 'application/json' }).end(payload);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MCP fixture has no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
