import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { ACTIVE_CRAWL_STATES, isWebTool, WEB_CRAWL, type WebTool } from '@/lib/research';
import { requestCrawlCancellation } from '@/lib/runtime/research/crawls';
import type { WebResearchSeeds } from '@/lib/runtime/research/seeds';
import { firecrawlCredentialSubject } from '@/lib/runtime/research/settings';
import { crawlAllowed, publicPageUrl } from '@/lib/runtime/research/urls';
import { encryptSecret } from '@/lib/runtime/secrets';
import {
  agents,
  audit,
  firecrawlCredentials,
  knowledgeDocuments,
  webCitations,
  webCrawls,
} from '@/lib/schema';
import { uploadKnowledgeDocument } from '@/lib/server/knowledge-mutations';

async function lockAgent(tx: Tx, agentId: string) {
  const [agent] = await tx
    .select({ id: agents.id, enabledTools: agents.enabledTools })
    .from(agents)
    .where(eq(agents.id, agentId))
    .for('update');
  return agent;
}

export async function persistWebResearchAccess(
  actor: string,
  agentId: string,
  tools: WebTool[],
  scopes: string[],
  seeds: WebResearchSeeds,
) {
  return db().transaction(async (tx) => {
    const agent = await lockAgent(tx, agentId);
    if (!agent) return { error: 'Agent not found.' };
    await tx
      .update(agents)
      .set({
        enabledTools: [...agent.enabledTools.filter((tool) => !isWebTool(tool)), ...tools],
        webCrawlScopes: scopes,
        webResearchSeeds: seeds,
      })
      .where(eq(agents.id, agentId));
    const [active] = await tx
      .select({ id: webCrawls.id, seedUrl: webCrawls.seedUrl })
      .from(webCrawls)
      .where(and(eq(webCrawls.agentId, agentId), inArray(webCrawls.status, ACTIVE_CRAWL_STATES)));
    if (active) {
      const seed = publicPageUrl(active.seedUrl);
      if (!tools.includes(WEB_CRAWL) || !seed || !crawlAllowed(seed, scopes)) {
        await requestCrawlCancellation(tx, agentId, 'Crawl access was removed.', active.id);
      }
    }
    await tx
      .insert(audit)
      .values({ actor, action: 'Updated web research access for agent ' + agentId });
    return { message: 'Web research access saved.' };
  });
}

export async function persistFirecrawlCredential(
  actor: string,
  agentId: string,
  key: string | null,
) {
  let encrypted: string | null = null;
  if (key) {
    try {
      encrypted = encryptSecret(firecrawlCredentialSubject(agentId), key);
    } catch {
      return { error: 'Configure ORBIT_ENCRYPTION_KEY before saving an agent key.' };
    }
  }
  return db().transaction(async (tx) => {
    if (!(await lockAgent(tx, agentId))) return { error: 'Agent not found.' };
    if (encrypted) {
      await tx
        .insert(firecrawlCredentials)
        .values({ agentId, encryptedKey: encrypted })
        .onConflictDoUpdate({
          target: firecrawlCredentials.agentId,
          set: { encryptedKey: encrypted },
        });
    } else {
      await tx.delete(firecrawlCredentials).where(eq(firecrawlCredentials.agentId, agentId));
    }
    await tx.insert(audit).values({
      actor,
      action: (encrypted ? 'Saved' : 'Removed') + ' Firecrawl credential for agent ' + agentId,
    });
    return { message: encrypted ? 'Agent key saved.' : 'Agent key removed.' };
  });
}

export async function cancelWebCrawl(actor: string, agentId: string, crawlId: string) {
  return db().transaction(async (tx) => {
    if (!(await lockAgent(tx, agentId))) return { error: 'Agent not found.' };
    if (!(await requestCrawlCancellation(tx, agentId, 'Cancelled by an administrator.', crawlId))) {
      const [crawl] = await tx
        .select({ status: webCrawls.status })
        .from(webCrawls)
        .where(and(eq(webCrawls.id, crawlId), eq(webCrawls.agentId, agentId)));
      if (!crawl) return { error: 'Crawl not found.' };
      if (crawl.status === 'cancelling') return { message: 'Cancellation requested.' };
      return { error: 'This crawl has already finished.' };
    }
    await tx
      .insert(audit)
      .values({ actor, action: 'Requested cancellation for web crawl ' + crawlId });
    return { message: 'Cancellation requested.' };
  });
}

export async function importWebCitation(
  actor: string,
  agentId: string,
  citationId: string,
  libraryId: string,
) {
  const store = db();
  const [citation] = await store
    .select({
      title: webCitations.title,
      url: webCitations.url,
      content: webCitations.content,
    })
    .from(webCitations)
    .where(and(eq(webCitations.agentId, agentId), eq(webCitations.id, citationId)));
  if (!citation?.content) return { error: 'Saved page content is unavailable.' };
  const [existing] = await store
    .select({ id: knowledgeDocuments.id })
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.libraryId, libraryId),
        eq(knowledgeDocuments.webCitationId, citationId),
      ),
    );
  if (existing) return { message: 'This page is already in the selected library.' };
  const text = 'Source URL: ' + citation.url + '\n\n' + citation.content;
  const bytes = new TextEncoder().encode(text);
  return uploadKnowledgeDocument(
    actor,
    { kind: 'library', id: libraryId },
    {
      name: 'web-page-' + citationId + '.md',
      type: 'text/markdown',
      size: bytes.byteLength,
      bytes,
    },
    { citationId, title: citation.title },
  );
}
