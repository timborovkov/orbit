import { z } from 'zod';

/** Admin-authored seed queries and source URLs for web research guidance. */
const webResearchSeedsSchema = z.object({
  queries: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  sources: z.array(z.string().trim().min(1).max(2048)).max(20).default([]),
});

export type WebResearchSeeds = z.infer<typeof webResearchSeedsSchema>;

export const emptyWebResearchSeeds: WebResearchSeeds = { queries: [], sources: [] };

export function parseWebResearchSeeds(value: unknown): WebResearchSeeds {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { queries?: unknown; sources?: unknown })
      : {};
  const normalize = (entries: unknown, maxLength: number) =>
    Array.isArray(entries)
      ? [
          ...new Set(
            entries
              .filter((entry): entry is string => typeof entry === 'string')
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0 && entry.length <= maxLength),
          ),
        ].slice(0, 20)
      : [];
  const parsed = webResearchSeedsSchema.safeParse({
    queries: normalize(raw.queries, 500),
    sources: normalize(raw.sources, 2048),
  });
  return parsed.success ? parsed.data : emptyWebResearchSeeds;
}

/** Parse list fields from a form (one entry per repeated name, or newline-delimited). */
export function listValuesFromForm(form: FormData, name: string, max = 20): string[] {
  const values = form
    .getAll(name)
    .flatMap((value) => (typeof value === 'string' ? value.split('\n') : []))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)].slice(0, max);
}

/** Compact prompt guidance injected when web tools are available. */
export function webResearchSeedGuidance(seeds: WebResearchSeeds): string | null {
  const lines: string[] = [];
  if (seeds.queries.length) {
    lines.push(
      'Preferred search queries (use when relevant; refine rather than inventing unrelated topics):',
    );
    for (const query of seeds.queries) lines.push(`- ${query}`);
  }
  if (seeds.sources.length) {
    lines.push('Preferred sources or starting URLs:');
    for (const source of seeds.sources) lines.push(`- ${source}`);
  }
  if (!lines.length) return null;
  return lines.join('\n');
}
