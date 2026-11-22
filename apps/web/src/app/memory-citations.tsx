import Link from 'next/link';

import { z } from 'zod';

import { MEMORY_LIMIT, memoryEvidenceHref, type MemoryRef } from '@/lib/runtime/memory/types';

export function MemoryCitations({
  agentId,
  references,
}: {
  agentId: string;
  references: MemoryRef[];
}) {
  if (!references.length) return null;
  return (
    <ul className="knowledge-citations" aria-label="Memory evidence">
      {references.map((entry, index) => (
        <li key={entry.id}>
          <Link className="memory-link" href={memoryEvidenceHref(agentId, entry)}>
            Memory evidence {index + 1}
          </Link>
        </li>
      ))}
    </ul>
  );
}

const memoryReferences = z.array(z.object({ id: z.uuid(), revision: z.uuid() })).max(MEMORY_LIMIT);

export function MemoryToolResult({ agentId, output }: { agentId: string; output: unknown }) {
  const parsed = memoryReferences.safeParse(output);
  return parsed.success ? <MemoryCitations agentId={agentId} references={parsed.data} /> : null;
}
