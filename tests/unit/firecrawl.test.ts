import { expect, test } from 'bun:test';

import { crawlCleanupExpired, crawlCleanupGraceMs } from '@/lib/runtime/research/crawls';
import { firecrawlClient } from '@/lib/runtime/research/firecrawl';
import { parseFirecrawlEnv } from '@/lib/runtime/research/settings';
import {
  crawlAllowed,
  pageWithinScope,
  parseCrawlScopes,
  providerPathPatterns,
  publicPageUrl,
} from '@/lib/runtime/research/urls';

const signal = new AbortController().signal;
function mockFetch(handler: (url: URL, init: RequestInit) => Response) {
  return ((input: URL, init: RequestInit) => Promise.resolve(handler(input, init))) as typeof fetch;
}

test('uses the hosted default with the resolved bearer and redacts it from evidence', async () => {
  const config = parseFirecrawlEnv({ FIRECRAWL_API_KEY: 'unit-default-key' });
  const client = firecrawlClient(
    config,
    mockFetch((url, init) => {
      expect(url.href).toBe('https://api.firecrawl.dev/v2/search');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer unit-default-key');
      expect(init.redirect).toBe('manual');
      return Response.json({
        success: true,
        data: {
          web: [
            {
              url: 'https://docs.firecrawl.dev/',
              title: 'Docs',
              description: 'See unit-default-key',
            },
            { url: 'https://example.com/second', title: 'Second', description: 'Second excerpt' },
          ],
        },
      });
    }),
  );
  expect(await client.search('Firecrawl API documentation', 5, signal)).toMatchObject([
    { rank: 1, url: 'https://docs.firecrawl.dev/', excerpt: 'See [redacted]' },
    { rank: 2, url: 'https://example.com/second', excerpt: 'Second excerpt' },
  ]);
});

test('routes all operations, pagination, and cancellation to the configured custom origin', async () => {
  const visited: string[] = [];
  const config = parseFirecrawlEnv({ FIRECRAWL_API_ORIGIN: 'http://127.0.0.1:3002' });
  const client = firecrawlClient(
    config,
    mockFetch((url, init) => {
      expect(url.origin).toBe(config.origin);
      expect(new Headers(init.headers).has('authorization')).toBe(false);
      expect(init.redirect).toBe('manual');
      visited.push(init.method + ' ' + url.pathname + url.search);
      const page = { markdown: '# Content', metadata: { url: 'https://example.com/docs' } };
      if (url.pathname.endsWith('/search')) return Response.json({ data: { web: [] } });
      if (url.pathname.endsWith('/scrape')) return Response.json({ data: page });
      if (init.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          limit: 2,
          maxDiscoveryDepth: 1,
          sitemap: 'skip',
          allowExternalLinks: false,
        });
        return Response.json({ id: 'provider-job' });
      }
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({
        status: 'completed',
        completed: 2,
        total: 2,
        data: [page],
        next: url.search ? null : 'https://example.net/v2/crawl/provider-job?skip=1',
      });
    }),
  );
  const seed = new URL('https://example.com/docs');
  await client.search('public documentation', 5, signal);
  expect(await client.read(seed, signal)).toMatchObject({ content: '# Content' });
  const id = await client.start(seed, 2, 1, signal);
  const first = await client.poll(id, 0, 2, signal);
  expect(first.next).toBe(1);
  expect((await client.poll(id, first.next!, 2, signal)).next).toBe(null);
  await client.cancel(id, signal);
  expect(visited).toEqual([
    'POST /v2/search',
    'POST /v2/scrape',
    'POST /v2/crawl',
    'GET /v2/crawl/provider-job',
    'GET /v2/crawl/provider-job?skip=1',
    'DELETE /v2/crawl/provider-job',
  ]);
});

test('reports unavailable Local search, lost jobs and unsafe provider pagination', async () => {
  const config = parseFirecrawlEnv({ FIRECRAWL_API_ORIGIN: 'http://localhost:3002' });
  const client = firecrawlClient(
    config,
    mockFetch((url) => {
      if (url.pathname.endsWith('/search'))
        return Response.json({ code: 'CLOUD_ONLY', error: 'untrusted details' }, { status: 501 });
      if (url.pathname.endsWith('/lost'))
        return Response.json({ code: 'JOB_NOT_FOUND' }, { status: 404 });
      return Response.json({
        status: 'completed',
        completed: 0,
        total: 0,
        next: 'https://example.net/v2/crawl/another-job?skip=1',
      });
    }),
  );
  await expect(client.search('query', 5, signal)).rejects.toThrow('Cloud forwarding disabled');
  await expect(client.poll('lost', 0, 2, signal)).rejects.toThrow('missing or expired');
  await expect(client.poll('job', 0, 2, signal)).rejects.toThrow('invalid crawl pagination');
  const redirect = firecrawlClient(
    { ...config, key: 'test-token' },
    mockFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://example.net/' } }),
    ),
  );
  await expect(redirect.read(new URL('https://example.com'), signal)).rejects.toThrow(
    'could not complete',
  );
});

test('validates origin-only configuration and public URL scope boundaries', () => {
  for (const origin of [
    'file:///tmp',
    'https://name:pw@example.com',
    'https://example.com/v2',
    'https://example.com?key=secret',
  ]) {
    expect(() => parseFirecrawlEnv({ FIRECRAWL_API_ORIGIN: origin })).toThrow('HTTP(S) origin');
  }
  for (const url of [
    'http://127.0.0.1',
    'http://[::1]',
    'http://[::ffff:7f00:1]',
    'http://169.254.169.254',
    'http://test.internal',
    'https://user:pw@example.com',
  ]) {
    expect(publicPageUrl(url)).toBeNull();
  }
  expect(publicPageUrl('https://example.com/citation#heading')?.href).toBe(
    'https://example.com/citation',
  );
  const seed = new URL('https://example.com/docs');
  const scopes = parseCrawlScopes('https://example.com/docs/\nhttps://example.com/docs')!;
  expect(scopes).toEqual(['https://example.com/docs']);
  expect(crawlAllowed(seed, scopes)).toBe(true);
  expect(crawlAllowed(new URL('https://example.org/docs'), ['*'])).toBe(true);
  expect(crawlAllowed(new URL('https://example.com/docs%2fshadow'), ['*'])).toBe(false);
  expect(pageWithinScope(new URL('https://example.com/docs/guides'), seed)).toBe(true);
  expect(pageWithinScope(new URL('https://example.com/docsite'), seed)).toBe(false);
  expect(pageWithinScope(new URL('https://other.example.com/docs'), seed)).toBe(false);
  expect(new RegExp(providerPathPatterns(seed)![0]).test('/docs/guides')).toBe(true);
});

test('uses the final crawl URL and distinguishes an unsupported read endpoint', async () => {
  const client = firecrawlClient(
    { origin: 'http://127.0.0.1:3002' },
    mockFetch((url) => {
      if (url.pathname === '/v2/scrape') {
        return Response.json({ detail: 'Not found' }, { status: 404 });
      }
      return Response.json({
        status: 'completed',
        completed: 2,
        total: 2,
        data: [
          {
            markdown: 'Unknown redirect destination',
            metadata: { sourceURL: 'https://example.com/docs' },
          },
          {
            markdown: 'Confirmed final page',
            metadata: {
              sourceURL: 'https://example.com/docs',
              url: 'https://example.com/docs/page',
            },
          },
        ],
      });
    }),
  );

  await expect(client.read(new URL('https://example.com/docs'), signal)).rejects.toMatchObject({
    kind: 'unavailable',
  });
  const status = await client.poll('provider-job', 0, 2, signal);
  expect(status.pages.map(({ url, rank }) => ({ url, rank }))).toEqual([
    { url: 'https://example.com/docs/page', rank: 2 },
  ]);
});

test('cleanup grace waits for the first provider cancel attempt', () => {
  const requestedAt = new Date('2026-01-01T00:00:00.000Z');
  const sentAt = new Date(requestedAt.getTime() + crawlCleanupGraceMs + 60_000);
  expect(
    crawlCleanupExpired({ cancellationSentAt: null }, requestedAt.getTime() + crawlCleanupGraceMs),
  ).toBe(false);
  expect(crawlCleanupExpired({ cancellationSentAt: sentAt }, sentAt.getTime())).toBe(false);
  expect(
    crawlCleanupExpired({ cancellationSentAt: sentAt }, sentAt.getTime() + crawlCleanupGraceMs),
  ).toBe(true);
});
