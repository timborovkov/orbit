import { z } from 'zod';

import { DEFAULT_FIRECRAWL_ORIGIN } from '@/lib/runtime/research/settings';
import { providerPathPatterns, publicPageUrl } from '@/lib/runtime/research/urls';

export interface ResearchPage {
  url: string;
  title: string;
  excerpt: string;
  content?: string;
  rank: number;
}

type FailureKind = 'unavailable' | 'not-found' | 'lost-job' | 'rejected' | 'retryable';
export class FirecrawlError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
  }
}

const operationUnavailable = 'The configured Firecrawl endpoint does not support this operation.';
const invalidResponse = 'Firecrawl returned an invalid response.';
const maxResponseBytes = 16 * 1024 * 1024;
const jobIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const envelope = z.object({
  success: z.boolean().optional(),
  code: z.string().optional(),
  id: jobIdSchema.optional(),
  data: z.unknown().optional(),
});
const searchHit = z.object({
  url: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
});
const scrapedPage = z.object({
  markdown: z.string().optional(),
  metadata: z.object({
    sourceURL: z.string().optional(),
    url: z.string().optional(),
    title: z.string().nullish(),
    statusCode: z.number().optional(),
  }),
  blocked: z.boolean().optional(),
});
const crawlResponse = z.object({
  status: z.enum(['scraping', 'running', 'completed', 'failed', 'cancelled']),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  creditsUsed: z.number().int().nonnegative().nullish(),
  data: z.array(z.unknown()).default([]),
  next: z.string().nullish(),
});

async function parseBody(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > maxResponseBytes)
    throw new FirecrawlError('rejected', 'The Firecrawl response exceeded the size limit.');
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes)
        throw new FirecrawlError('rejected', 'The Firecrawl response exceeded the size limit.');
      text += decoder.decode(value, { stream: true });
    }
    try {
      return JSON.parse(text + decoder.decode()) as unknown;
    } catch {
      return null;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function firecrawlClient(
  { origin, key }: { origin: string; key?: string },
  fetchRequest: typeof fetch = fetch,
) {
  const clean = (value: string) => {
    if (!key) return value;
    const encodedKey = encodeURIComponent(key);
    return value.replaceAll(key, '[redacted]').replaceAll(encodedKey, '[redacted]');
  };
  const source = (value: string) => {
    if (value !== clean(value)) return null;
    return publicPageUrl(value)?.href ?? null;
  };

  const request = async (
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    signal: AbortSignal,
    body?: Record<string, unknown>,
  ) => {
    if (!key && origin === DEFAULT_FIRECRAWL_ORIGIN)
      throw new FirecrawlError(
        'unavailable',
        'Configure a Firecrawl API key for the hosted endpoint.',
      );
    const url = new URL(path, origin);
    const headers = new Headers({ accept: 'application/json' });
    if (key) headers.set('authorization', 'Bearer ' + key);
    if (body) headers.set('content-type', 'application/json');
    let response: Response;
    let payload: unknown;
    try {
      response = await fetchRequest(url, {
        method,
        headers,
        body: body && JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      payload = await parseBody(response);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof FirecrawlError) throw error;
      throw new FirecrawlError('retryable', 'The Firecrawl endpoint did not respond.');
    }
    const parsed = envelope.safeParse(payload);
    const code = parsed.data?.code;
    const status = response.status;
    if (code === 'CLOUD_ONLY' && path === '/v2/search')
      throw new FirecrawlError(
        'unavailable',
        'Search is unavailable with Firecrawl Local Cloud forwarding disabled.',
      );
    if (
      status === 404 &&
      method !== 'POST' &&
      (code === 'JOB_NOT_FOUND' || (origin === DEFAULT_FIRECRAWL_ORIGIN && parsed.success))
    )
      throw new FirecrawlError(
        'lost-job',
        'The provider crawl job is missing or expired. Start a new crawl to rerun it.',
      );
    if (status === 404 && path === '/v2/scrape' && parsed.success)
      throw new FirecrawlError('not-found', 'Firecrawl could not find the requested page.');
    if ([404, 405, 501].includes(status) || code === 'CLOUD_ONLY')
      throw new FirecrawlError('unavailable', operationUnavailable);
    if (status === 401 || status === 403)
      throw new FirecrawlError(
        'unavailable',
        'Firecrawl refused this operation. Check endpoint access and credentials.',
      );
    if (status === 402)
      throw new FirecrawlError('unavailable', 'The Firecrawl account has insufficient credits.');
    if (status === 408 || status === 429 || status >= 500)
      throw new FirecrawlError(
        'retryable',
        'Firecrawl is temporarily unavailable or rate limited.',
      );
    if (!response.ok || parsed.data?.success === false)
      throw new FirecrawlError('rejected', 'Firecrawl could not complete this request.');
    if (!parsed.success) {
      throw new FirecrawlError(
        path === '/v2/crawl' && method === 'POST' ? 'retryable' : 'rejected',
        invalidResponse,
      );
    }
    return { envelope: parsed.data, payload };
  };

  function page(raw: unknown, rank: number): ResearchPage | undefined {
    const parsed = scrapedPage.safeParse(raw);
    if (!parsed.success) return undefined;
    const { markdown, metadata, blocked } = parsed.data;
    if (blocked || (metadata.statusCode && metadata.statusCode >= 400) || !markdown?.trim())
      return undefined;
    const url = source(metadata.url ?? metadata.sourceURL ?? '');
    if (!url) return undefined;
    const content = clean(markdown).slice(0, 32_000);
    return {
      url,
      title: clean(metadata.title || url).slice(0, 300),
      excerpt: content.slice(0, 600),
      content,
      rank,
    };
  }

  const jobPath = (id: string) => '/v2/crawl/' + jobIdSchema.parse(id);

  function getNext(value: string | null | undefined, path: string, skip: number) {
    if (!value) return null;
    const next = URL.parse(value, origin);
    const cursor = next?.searchParams.get('skip') ?? '';
    if (
      !next ||
      next.pathname !== path ||
      !['http:', 'https:'].includes(next.protocol) ||
      !/^\d{1,4}$/.test(cursor) ||
      next.searchParams.size !== 1 ||
      Number(cursor) < skip
    ) {
      throw new FirecrawlError('rejected', 'Firecrawl returned an invalid crawl pagination link.');
    }
    return Number(cursor) === skip ? null : Number(cursor);
  }

  return {
    async search(query: string, limit: number, signal: AbortSignal) {
      const { envelope } = await request('/v2/search', 'POST', signal, {
        query,
        limit,
        sources: ['web'],
      });
      const web = z.object({ web: z.array(z.unknown()).default([]) }).safeParse(envelope.data);
      if (!web.success) throw new FirecrawlError('rejected', invalidResponse);
      return web.data.web.slice(0, limit).flatMap((raw, index): ResearchPage[] => {
        const hit = searchHit.safeParse(raw);
        const url = hit.success && source(hit.data.url);
        if (!hit.success || !url) return [];
        return [
          {
            url,
            title: clean(hit.data.title || url).slice(0, 300),
            excerpt: clean(hit.data.description ?? '').slice(0, 600),
            rank: index + 1,
          },
        ];
      });
    },
    async read(url: URL, signal: AbortSignal) {
      const { envelope } = await request('/v2/scrape', 'POST', signal, {
        url: url.href,
        formats: ['markdown'],
        onlyMainContent: true,
      });
      const result = page(envelope.data, 1);
      if (!result)
        throw new FirecrawlError(
          'not-found',
          'Firecrawl returned no readable public content for this page.',
        );
      return result;
    },
    async start(seed: URL, pageLimit: number, depthLimit: number, signal: AbortSignal) {
      const { envelope } = await request('/v2/crawl', 'POST', signal, {
        url: seed.href,
        limit: pageLimit,
        maxDiscoveryDepth: depthLimit,
        includePaths: providerPathPatterns(seed),
        crawlEntireDomain: false,
        allowExternalLinks: false,
        allowSubdomains: false,
        ignoreQueryParameters: true,
        sitemap: 'skip',
        maxConcurrency: 2,
        scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
      });
      if (!envelope.id || envelope.id !== clean(envelope.id))
        throw new FirecrawlError('retryable', 'Firecrawl did not confirm crawl submission.');
      return envelope.id;
    },
    async poll(id: string, skip: number, pageLimit: number, signal: AbortSignal) {
      const path = jobPath(id);
      const { payload } = await request(path + (skip ? '?skip=' + skip : ''), 'GET', signal);
      const parsed = crawlResponse.safeParse(payload);
      if (!parsed.success) throw new FirecrawlError('rejected', invalidResponse);
      const { data, next, ...progress } = parsed.data;
      return {
        ...progress,
        next: getNext(next, path, skip),
        rawCount: data.length,
        pages: data.slice(0, pageLimit).flatMap((raw, index) => {
          const result = page(raw, skip + index + 1);
          return result ? [result] : [];
        }),
      };
    },
    async cancel(id: string, signal: AbortSignal) {
      await request(jobPath(id), 'DELETE', signal);
    },
  };
}
