import { z } from 'zod';

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
            <a className="knowledge-source-link" href={source.url} rel="noreferrer">
              {source.title || source.url}
            </a>
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
