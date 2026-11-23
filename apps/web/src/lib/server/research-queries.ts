import 'server-only';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { isWebTool } from '@/lib/research';
import { firecrawlKeySource } from '@/lib/runtime/research/settings';
import {
  agents,
  firecrawlCredentials,
  knowledgeLibraries,
  webCitations,
  webCrawls,
} from '@/lib/schema';

export async function getWebResearchActivity(agentId: string, runIds: string[]) {
  await requireAdmin();
  const store = db();
  const [crawls, citations, libraries] = runIds.length
    ? await Promise.all([
        store
          .select({
            id: webCrawls.id,
            runId: webCrawls.runId,
            seedUrl: webCrawls.seedUrl,
            status: webCrawls.status,
            reason: webCrawls.reason,
            pageLimit: webCrawls.pageLimit,
            depthLimit: webCrawls.depthLimit,
            completedPages: webCrawls.completedPages,
            discoveredPages: webCrawls.discoveredPages,
            creditsUsed: webCrawls.creditsUsed,
          })
          .from(webCrawls)
          .where(and(eq(webCrawls.agentId, agentId), inArray(webCrawls.runId, runIds)))
          .orderBy(asc(webCrawls.createdAt)),
        store
          .select({
            id: webCitations.id,
            runId: webCitations.runId,
            crawlId: webCitations.crawlId,
            rank: webCitations.rank,
            title: webCitations.title,
            url: webCitations.url,
            tool: webCitations.tool,
            excerpt: webCitations.excerpt,
            importable: sql<boolean>`${webCitations.content} is not null`,
          })
          .from(webCitations)
          .where(and(eq(webCitations.agentId, agentId), inArray(webCitations.runId, runIds)))
          .orderBy(asc(webCitations.createdAt), asc(webCitations.rank)),
        store
          .select({ id: knowledgeLibraries.id, name: knowledgeLibraries.name })
          .from(knowledgeLibraries)
          .orderBy(asc(knowledgeLibraries.name)),
      ])
    : [[], [], []];
  return { crawls, citations, libraries };
}

export async function getWebResearchAccess(agentId: string) {
  await requireAdmin();
  const [row] = await db()
    .select({
      tools: agents.enabledTools,
      scopes: agents.webCrawlScopes,
      override: firecrawlCredentials.agentId,
    })
    .from(agents)
    .leftJoin(firecrawlCredentials, eq(firecrawlCredentials.agentId, agents.id))
    .where(eq(agents.id, agentId));
  return {
    tools: row?.tools.filter(isWebTool) ?? [],
    scopes: row?.scopes ?? [],
    keySource: firecrawlKeySource(Boolean(row?.override)),
  };
}
