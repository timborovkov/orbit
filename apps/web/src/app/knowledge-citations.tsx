import { z } from 'zod';

import { knowledgeSourceHref, knowledgeSourceSchema } from '@/app/knowledge-shared';

export function KnowledgeCitations({
  agentId,
  sources,
}: {
  agentId: string;
  sources: z.infer<typeof knowledgeSourceSchema>[];
}) {
  if (!sources.length) return null;
  return (
    <ul className="knowledge-citations">
      {sources.map((source) => {
        const href = knowledgeSourceHref(agentId, source.documentId);
        return (
          <li key={source.id}>
            <strong>
              [{source.id}]{' '}
              {href ? (
                <a className="knowledge-source-link" href={href} download>
                  {source.sourceFilename}
                </a>
              ) : (
                source.sourceFilename
              )}
            </strong>
            {(source.page ?? source.section) && (
              <span className="muted">
                {' '}
                · {source.page ? `Page ${source.page}` : source.section}
              </span>
            )}
            <blockquote className="preserve-text">{source.content}</blockquote>
          </li>
        );
      })}
    </ul>
  );
}

const knowledgeToolOutput = z.object({
  reason: z.string().optional(),
  sources: z.array(knowledgeSourceSchema),
});

export function KnowledgeToolResult({ agentId, output }: { agentId: string; output: unknown }) {
  const result = knowledgeToolOutput.safeParse(output);
  if (!result.success) return null;
  const { sources, reason } = result.data;
  return (
    <section className="playground-knowledge-sources" aria-label="Knowledge search">
      <p className="muted">{sources.length ? 'Knowledge sources' : reason}</p>
      <KnowledgeCitations agentId={agentId} sources={sources} />
    </section>
  );
}
