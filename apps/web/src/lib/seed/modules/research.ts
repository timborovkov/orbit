import { WEB_CRAWL } from '@/lib/research';
import { actionIntents, webCitations, webCrawls } from '@/lib/schema';
import { DEMO_ACTOR, DEMO_AGENTS, DEMO_RUNS } from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

const intentId = '00000000-0000-4000-a400-00000000f201';
const crawlId = '00000000-0000-4000-a900-00000000f201';
const citationId = '00000000-0000-4000-a900-00000000f202';
const seedUrl = 'https://docs.firecrawl.dev/api-reference/endpoint';
const excerpt = 'Get Crawl Status returns the crawl status, progress and pages from the provider.';

export const researchModule: SeedModule = {
  name: 'web-research',
  async apply({ tx, now }) {
    const agentId = DEMO_AGENTS.john;
    const runId = DEMO_RUNS.johnSucceeded;
    await tx
      .insert(actionIntents)
      .values({
        id: intentId,
        agentId,
        runId,
        actionType: WEB_CRAWL,
        decision: 'allow',
        payload: {},
        recipients: [],
        reasons: ['Demo web research'],
        idempotencyKey: DEMO_ACTOR + ':web-research',
      })
      .onConflictDoNothing();
    await tx
      .insert(webCrawls)
      .values({
        id: crawlId,
        agentId,
        runId,
        intentId,
        seedUrl,
        originHash: 'demo',
        pageLimit: 10,
        depthLimit: 1,
        status: 'completed',
        completedPages: 1,
        discoveredPages: 1,
        creditsUsed: 0,
        deadline: now,
        finishedAt: now,
      })
      .onConflictDoNothing();
    await tx
      .insert(webCitations)
      .values({
        id: citationId,
        agentId,
        runId,
        intentId,
        crawlId,
        tool: WEB_CRAWL,
        rank: 1,
        url: seedUrl + '/crawl-get',
        title: 'Get Crawl Status',
        excerpt,
        content: excerpt,
      })
      .onConflictDoNothing();
  },
};
