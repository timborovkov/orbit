import Link from 'next/link';

import { NewKnowledgeLibrary } from '@/app/knowledge/new-library';
import { WorkspaceHeader } from '@/app/workspace-header';
import { LibraryEmpty, LibraryPageHeading, LibraryTable } from '@/components/library-table';
import { env } from '@/lib/env';
import { listKnowledgeLibraries } from '@/lib/server/knowledge-queries';
import { getPendingApprovalCount } from '@/lib/server/workspace-queries';

export const dynamic = 'force-dynamic';

export default async function KnowledgePage() {
  const [{ email, items }, pendingApprovalCount] = await Promise.all([
    listKnowledgeLibraries(),
    getPendingApprovalCount(),
  ]);
  return (
    <div className="agent-shell">
      <WorkspaceHeader current="/knowledge" pendingApprovalCount={pendingApprovalCount} />
      <main className="workspace-main" id="main" tabIndex={-1}>
        {env().AUTH_DISABLED && (
          <p className="local-auth-notice" role="status">
            Authentication disabled · Local development · {email}
          </p>
        )}
        <LibraryPageHeading
          title="Knowledge"
          description="Shared document libraries for agents."
          action={<NewKnowledgeLibrary />}
        />
        {items.length ? (
          <>
            <LibraryTable
              columns={['Library', 'Documents', 'Agents with access']}
              hasActions={false}
            >
              {items.map((library) => (
                <tr key={library.id}>
                  <td>
                    <Link
                      className="library-primary knowledge-source-link"
                      href={`/knowledge/${library.id}`}
                    >
                      {library.name}
                    </Link>
                  </td>
                  <td className="library-meta">{library.documentCount}</td>
                  <td className="library-meta">{library.agentCount}</td>
                </tr>
              ))}
            </LibraryTable>
            <ul className="library-card-list">
              {items.map((library) => (
                <li key={library.id} className="library-card">
                  <div className="library-card-copy">
                    <Link
                      className="library-primary knowledge-source-link"
                      href={`/knowledge/${library.id}`}
                    >
                      {library.name}
                    </Link>
                    <p className="library-meta">
                      {library.documentCount}{' '}
                      {library.documentCount === 1 ? 'document' : 'documents'}
                      {' · '}
                      {library.agentCount} {library.agentCount === 1 ? 'agent' : 'agents'} with
                      access
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <LibraryEmpty
            title="No shared libraries yet"
            description="Create a library to upload documents and choose which agents can search them."
          />
        )}
      </main>
    </div>
  );
}
