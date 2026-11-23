export const WEB_SEARCH = 'web.search';
export const WEB_READ = 'web.read';
export const WEB_CRAWL = 'web.crawl';
const WEB_TOOLS = [WEB_SEARCH, WEB_READ, WEB_CRAWL] as const;
export type WebTool = (typeof WEB_TOOLS)[number];

export function isWebTool(value: string): value is WebTool {
  return WEB_TOOLS.some((tool) => tool === value);
}

export const WEB_CRAWL_JOB = 'web.crawl';
export const ACTIVE_CRAWL_STATES = ['queued', 'submitting', 'running', 'cancelling'] as const;
export type CrawlStatus =
  (typeof ACTIVE_CRAWL_STATES)[number] | 'completed' | 'cancelled' | 'failed' | 'unavailable';

export const crawlLimits = {
  defaultPages: 10,
  maxPages: 25,
  defaultDepth: 1,
  maxDepth: 3,
  dailyPages: 100,
  deadlineMs: 10 * 60_000,
} as const;

export type ResearchKeySource = 'agent' | 'environment' | 'keyless' | 'missing';
