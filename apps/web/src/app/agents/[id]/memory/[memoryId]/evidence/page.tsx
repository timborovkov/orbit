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
            <h2 id="memory-source-heading">
              {evidence.email ? 'Original inbound message' : 'Original discovery event'}
            </h2>
            {evidence.email && (
              <p className="preserve-text">
                {evidence.email.subject} · {evidence.email.sender}
              </p>
            )}
            {evidence.event?.author && <p className="muted">@{evidence.event.author}</p>}
            <p className="preserve-text">{evidence.email?.body ?? evidence.event?.text}</p>
          </section>
          {evidence.email ? (
            <Link
              className="memory-link"
              href={`/agents/${id}?tab=email&emailThread=${evidence.email.threadId}`}
            >
              Open email thread
            </Link>
          ) : (
            <Link
              className="memory-link"
              href={`/agents/${id}?run=${evidence.runId}#run-${evidence.runId}`}
            >
              View originating run
            </Link>
          )}
        </article>
      </main>
    </div>
  );
}
