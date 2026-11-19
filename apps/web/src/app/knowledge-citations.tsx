import { z } from 'zod';

import { knowledgeSourceSchema } from '@/app/knowledge-shared';

export function KnowledgeCitations({
  sources,
}: {
  sources: z.infer<typeof knowledgeSourceSchema>[];
}) {
  if (!sources.length) return null;
  return (
    <ul className="knowledge-citations">
      {sources.map((source) => (
        <li key={source.id}>
          <strong>
            [{source.id}] {source.sourceFilename}
          </strong>
          {(source.page ?? source.section) && (
            <span className="muted"> · {source.page ? `Page ${source.page}` : source.section}</span>
          )}
          <blockquote className="preserve-text">{source.content}</blockquote>
        </li>
      ))}
    </ul>
  );
}

const knowledgeToolOutput = z.object({
  reason: z.string().optional(),
  sources: z.array(knowledgeSourceSchema),
});

export function KnowledgeToolResult({ output }: { output: unknown }) {
  const result = knowledgeToolOutput.safeParse(output);
  if (!result.success) return null;
  const { sources, reason } = result.data;
  return (
    <section className="playground-knowledge-sources" aria-label="Knowledge search">
      <p className="muted">{sources.length ? 'Sources from this agent’s library' : reason}</p>
      <KnowledgeCitations sources={sources} />
    </section>
  );
}
