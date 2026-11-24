'use server';

import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { configSchema } from '@/lib/runtime/config';
import { createXSearchAdapter } from '@/lib/runtime/x/adapter';
import { clampDiscoveryMaxPosts } from '@/lib/runtime/x/discovery-cost';
import {
  prefilterDiscoveryPosts,
  scoreDiscoveryRelevance,
} from '@/lib/runtime/x/relevance-prefilter';
import { resolveXBearerToken } from '@/lib/runtime/x/settings';
import { agents, configurations } from '@/lib/schema';

export async function previewXDiscoveryQuery(form: FormData): Promise<{
  error?: string;
  message?: string;
  posts?: {
    id: string;
    text: string;
    authorUsername?: string;
    relevant: boolean;
    matchedTerms: string[];
  }[];
}> {
  await checkOrigin();
  await requireAdmin();
  const agentId = z.uuid().safeParse(form.get('agentId'));
  const query = z.string().trim().min(1).max(512).safeParse(form.get('query'));
  const maxPosts = clampDiscoveryMaxPosts(Number(form.get('maxPosts') ?? 10));
  if (!agentId.success) return { error: 'Agent not found.' };
  if (!query.success) return { error: 'Enter a query to preview.' };

  const store = db();
  const [agent] = await store
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, agentId.data));
  if (!agent) return { error: 'Agent not found.' };

  const [version] = await store
    .select({ config: configurations.config })
    .from(configurations)
    .where(eq(configurations.agentId, agentId.data))
    .orderBy(desc(configurations.version))
    .limit(1);
  const config = version ? configSchema.parse(version.config) : null;

  const adapter = createXSearchAdapter(resolveXBearerToken());
  const availability = adapter.availability();
  if (!availability.available) return { error: availability.reason };

  try {
    const search = await adapter.searchRecent({
      query: query.data,
      maxResults: Math.min(Math.max(maxPosts, 10), 100),
    });
    const capped = search.posts.slice(0, maxPosts);
    const criteria = {
      mission: config?.mission,
      engagementCriteria: config?.engagementCriteria,
      hints: [query.data],
    };
    const { dropped } = prefilterDiscoveryPosts(capped, criteria);
    const posts = capped.map((post) => {
      const decision = scoreDiscoveryRelevance(post.text, criteria);
      return {
        id: post.id,
        text: post.text,
        authorUsername: post.authorUsername,
        relevant: decision.relevant,
        matchedTerms: decision.matchedTerms,
      };
    });
    return {
      message: `Sampled ${posts.length} post${posts.length === 1 ? '' : 's'} without saving. ${dropped} would be skipped by the relevance pre-filter.`,
      posts,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message.slice(0, 300) : 'X preview search failed.',
    };
  }
}
