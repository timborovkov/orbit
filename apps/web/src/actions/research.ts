'use server';

import { revalidatePath } from 'next/cache';

import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { listValuesFromForm } from '@/lib/form-values';
import { isWebTool } from '@/lib/research';
import { parseWebResearchSeeds } from '@/lib/runtime/research/seeds';
import { firecrawlKeySchema } from '@/lib/runtime/research/settings';
import { parseCrawlScopes } from '@/lib/runtime/research/urls';
import {
  cancelWebCrawl,
  importWebCitation,
  persistFirecrawlCredential,
  persistWebResearchAccess,
} from '@/lib/server/research-mutations';

type ResearchActionState = { error?: string; message?: string };

async function agentParams(
  form: FormData,
): Promise<{ error: string } | { actor: string; agentId: string }> {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = z.uuid().safeParse(form.get('agentId'));
  if (!agentId.success) return { error: 'Agent not found.' } as const;
  return { actor, agentId: agentId.data };
}

export async function saveWebResearchAccess(form: FormData): Promise<ResearchActionState> {
  const params = await agentParams(form);
  if ('error' in params) return params;
  const tools = form.getAll('tools');
  const rawScopes = form.get('scopes');
  if (
    typeof rawScopes !== 'string' ||
    rawScopes.length > 10_000 ||
    !tools.every((tool) => typeof tool === 'string' && isWebTool(tool))
  ) {
    return { error: 'Check the selected tools and crawl scopes.' };
  }
  const scopes = parseCrawlScopes(rawScopes);
  if (!scopes) return { error: 'Enter up to 30 public site or path URLs, one per line, or use *.' };
  const seeds = parseWebResearchSeeds({
    queries: listValuesFromForm(form, 'seedQuery'),
    sources: listValuesFromForm(form, 'seedSource'),
  });
  const result = await persistWebResearchAccess(
    params.actor,
    params.agentId,
    [...new Set(tools)],
    scopes,
    seeds,
  );
  if (!result.error) revalidatePath('/agents/' + params.agentId);
  return result;
}

export async function saveFirecrawlCredential(form: FormData): Promise<ResearchActionState> {
  const params = await agentParams(form);
  if ('error' in params) return params;
  const revoke = form.get('revoke') === 'true';
  const parsed = firecrawlKeySchema.safeParse(form.get('credential'));
  if (!revoke && !parsed.success) return { error: 'Enter a valid Firecrawl key.' };
  const result = await persistFirecrawlCredential(
    params.actor,
    params.agentId,
    revoke ? null : parsed.data!,
  );
  if (!result.error) revalidatePath('/agents/' + params.agentId);
  return result;
}

export async function requestWebCrawlCancellation(form: FormData): Promise<ResearchActionState> {
  const params = await agentParams(form);
  if ('error' in params) return params;
  const crawlId = z.uuid().safeParse(form.get('crawlId'));
  if (!crawlId.success) return { error: 'Crawl not found.' };
  const result = await cancelWebCrawl(params.actor, params.agentId, crawlId.data);
  if (!result.error) revalidatePath('/agents/' + params.agentId);
  return result;
}

export async function importWebResearchPage(form: FormData): Promise<ResearchActionState> {
  const params = await agentParams(form);
  if ('error' in params) return params;
  const citationId = z.uuid().safeParse(form.get('citationId'));
  const libraryId = z.uuid().safeParse(form.get('libraryId'));
  if (!citationId.success || !libraryId.success)
    return { error: 'Choose a saved page and shared library.' };
  const result = await importWebCitation(
    params.actor,
    params.agentId,
    citationId.data,
    libraryId.data,
  );
  if (!('error' in result)) {
    revalidatePath('/knowledge');
    revalidatePath('/knowledge/' + libraryId.data);
    revalidatePath('/agents/' + params.agentId);
  }
  return result;
}
