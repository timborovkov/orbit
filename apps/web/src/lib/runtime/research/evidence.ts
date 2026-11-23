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

export async function saveWebCitations(tx: Tx, owner: EvidenceOwner, pages: ResearchPage[]) {
  if (!pages.length) return;
  await tx
    .insert(webCitations)
    .values(pages.map((page) => ({ ...owner, ...page })))
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
