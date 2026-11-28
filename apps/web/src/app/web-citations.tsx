import { z } from 'zod';

import { ExternalLink } from '@/components/external-link';

const webSourceSchema = z.object({
  id: z.number().int().positive(),
  url: z.string().min(1),
  title: z.string(),
  excerpt: z.string(),
});

export function WebCitations({ sources }: { sources: z.infer<typeof webSourceSchema>[] }) {
  if (!sources.length) return null;
  return (
    <ul className="knowledge-citations" aria-label="Web sources">
      {sources.map((source) => (
        <li key={source.url}>
          <strong>
            [{source.id}]{' '}
            <ExternalLink className="knowledge-source-link" href={source.url}>
              {source.title || source.url}
            </ExternalLink>
          </strong>
          <blockquote className="preserve-text">{source.excerpt}</blockquote>
        </li>
      ))}
    </ul>
  );
}

export function WebToolResult({ output }: { output: unknown }) {
  const parsed = z.array(webSourceSchema).safeParse(output);
  return parsed.success ? <WebCitations sources={parsed.data} /> : null;
}
