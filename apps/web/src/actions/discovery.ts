'use server';

import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { normalizeDiscoveryFilters } from '@/lib/runtime/x/discovery-filters';
import { type DiscoveryPreviewResult, previewDiscoveryQuery } from '@/lib/server/discovery-preview';

export async function previewXDiscoveryQuery(form: FormData): Promise<DiscoveryPreviewResult> {
  await checkOrigin();
  await requireAdmin();
  const agentId = z.uuid().safeParse(form.get('agentId'));
  const query = z.string().trim().min(1).max(512).safeParse(form.get('query'));
  if (!agentId.success) return { error: 'Agent not found.' };
  if (!query.success) return { error: 'Enter a query to preview.' };
  const filtersRaw = form.get('xDiscoveryFilters');
  let filters = undefined;
  if (typeof filtersRaw === 'string' && filtersRaw.trim()) {
    try {
      filters = normalizeDiscoveryFilters(JSON.parse(filtersRaw) as unknown);
    } catch {
      filters = normalizeDiscoveryFilters(undefined);
    }
  }
  return previewDiscoveryQuery({
    agentId: agentId.data,
    query: query.data,
    maxPosts: Number(form.get('maxPosts') ?? 10),
    filters,
  });
}
