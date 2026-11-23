import { and, asc, eq } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import type { WebTool } from '@/lib/research';
import type { ResearchPage } from '@/lib/runtime/research/firecrawl';
import { webCitations } from '@/lib/schema';

interface EvidenceOwner {
  agentId: string;
  runId: string;
  intentId: string;
  tool: WebTool;
  crawlId?: string;
}

export async function saveWebCitations(
  tx: Tx,
  owner: EvidenceOwner,
  pages: ResearchPage[],
  pageLimit?: number,
) {
  if (!pages.length) return;
  let additions = pages;
  if (pageLimit !== undefined) {
    additions = [];
    // The crawl worker holds the crawl lock. Count unique pages across all of its polls.
    const saved = await tx
      .select({ url: webCitations.url })
      .from(webCitations)
      .where(eq(webCitations.intentId, owner.intentId));
    const seen = new Set(saved.map(({ url }) => url));
    for (const page of pages) {
      if (seen.size >= pageLimit) break;
      if (seen.has(page.url)) continue;
      seen.add(page.url);
      additions.push(page);
    }
  }
  if (!additions.length) return;
  await tx
    .insert(webCitations)
    .values(additions.map((page) => ({ ...owner, ...page })))
    .onConflictDoNothing({ target: [webCitations.intentId, webCitations.url] });
}

export async function webCitationsForTool(owner: EvidenceOwner) {
  return db()
    .select({
      citationId: webCitations.id,
      rank: webCitations.rank,
      url: webCitations.url,
      title: webCitations.title,
      excerpt: webCitations.excerpt,
      content: webCitations.content,
    })
    .from(webCitations)
    .where(
      and(
        eq(webCitations.agentId, owner.agentId),
        eq(webCitations.runId, owner.runId),
        eq(webCitations.intentId, owner.intentId),
      ),
    )
    .orderBy(asc(webCitations.rank));
}
