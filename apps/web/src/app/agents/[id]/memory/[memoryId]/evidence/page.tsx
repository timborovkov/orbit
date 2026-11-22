import Link from 'next/link';
import { notFound } from 'next/navigation';

import { z } from 'zod';

import { WorkspaceHeader } from '@/app/workspace-header';
import { requireAdmin } from '@/lib/auth';
import { formatUtcTimestamp } from '@/lib/format';
import { getAgentMemoryEvidence } from '@/lib/server/memory-queries';
import { getPendingApprovalCount } from '@/lib/server/workspace-queries';

export default async function MemoryEvidence({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; memoryId: string }>;
  searchParams: Promise<{ revision?: string }>;
}) {
  await requireAdmin();
  const { id, memoryId } = await params;
  const revision = (await searchParams).revision;
  const key = z.tuple([z.uuid(), z.uuid(), z.uuid()]).safeParse([id, memoryId, revision]);
  if (!key.success) notFound();
  const [evidence, pendingApprovalCount] = await Promise.all([
    getAgentMemoryEvidence(...key.data),
    getPendingApprovalCount(),
  ]);
  if (!evidence) notFound();
  const { source } = evidence;
  const attribution = [source.title, source.author].filter(Boolean).join(' · ');
  return (
    <div className="agent-shell">
      <WorkspaceHeader pendingApprovalCount={pendingApprovalCount} />
      <main id="main" tabIndex={-1} className="workspace-main">
        <nav className="agent-breadcrumb" aria-label="Breadcrumb">
          <Link href={`/agents/${id}?tab=memory`}>Memory</Link>
        </nav>
        <article className="memory-evidence">
          <h1>
            {evidence.subject} · {evidence.topic}
          </h1>
          <p className="muted">{formatUtcTimestamp(evidence.sourceAt)}</p>
          <section aria-labelledby="memory-quote-heading">
            <h2 id="memory-quote-heading">
              {evidence.correctedBy ? 'Originally learned from' : 'Supporting quote'}
            </h2>
            <blockquote className="preserve-text">{evidence.quote}</blockquote>
          </section>
          <section aria-labelledby="memory-source-heading">
            <h2 id="memory-source-heading">{source.label}</h2>
            {attribution && <p className="preserve-text">{attribution}</p>}
            <p className="preserve-text">{source.body}</p>
          </section>
          <Link className="memory-link" href={source.href}>
            {source.linkLabel}
          </Link>
        </article>
      </main>
    </div>
  );
}
