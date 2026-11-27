import Link from 'next/link';
import { notFound } from 'next/navigation';

import { z } from 'zod';

import { KnowledgeDocumentsSection } from '@/app/knowledge-documents-section';
import { AgentKnowledgeGrant } from '@/app/knowledge/[id]/agent-grant';
import { PendingRunRefresh } from '@/app/pending-run-refresh';
import { env } from '@/lib/env';
import { workspaceKnowledgeIndexingConfigured } from '@/lib/runtime/knowledge/provider';
import { getKnowledgeLibrary } from '@/lib/server/knowledge-queries';
import { storageConfigured } from '@/lib/storage/objects';

export const dynamic = 'force-dynamic';

export default async function KnowledgeLibraryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const detail = await getKnowledgeLibrary(id.data);
  if (!detail) notFound();
  const { email, library, documents, agentAccess } = detail;
  return (
    <main className="workspace-main" id="main" tabIndex={-1}>
      {env().AUTH_DISABLED && (
        <p className="local-auth-notice" role="status">
          Authentication disabled · Local development · {email}
        </p>
      )}
      <nav className="agent-breadcrumb" aria-label="Breadcrumb">
        <Link href="/knowledge">Knowledge</Link>
      </nav>
      <div className="page-heading library-page-heading">
        <h1 className="knowledge-library-name">{library.name}</h1>
      </div>
      <PendingRunRefresh
        active={documents.some((doc) => doc.status === 'pending' || doc.status === 'processing')}
      />
      <div className="knowledge-workspace-sections">
        <KnowledgeDocumentsSection
          scope={{ kind: 'library', id: library.id }}
          documents={documents}
          storageReady={storageConfigured()}
          indexingReady={workspaceKnowledgeIndexingConfigured()}
        />
        <section className="access-workbench" aria-labelledby="knowledge-library-access-title">
          <div className="editor-section-heading">
            <h2 id="knowledge-library-access-title">Agent access</h2>
            <p className="muted">Agents also need knowledge.search enabled to use this library.</p>
          </div>
          {agentAccess.length ? (
            <ul className="knowledge-list">
              {agentAccess.map((agent) => (
                <AgentKnowledgeGrant key={agent.id} libraryId={library.id} agent={agent} />
              ))}
            </ul>
          ) : (
            <p className="muted">Create an agent before granting access.</p>
          )}
        </section>
      </div>
    </main>
  );
}
