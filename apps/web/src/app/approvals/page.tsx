import Image from 'next/image';
import Link from 'next/link';
import { z } from 'zod';

import { ApprovalsFilter } from '@/app/approvals-filter';
import { ApprovalsInbox } from '@/app/approvals-inbox';
import { ThemeSwitch } from '@/app/theme';
import { requireAdmin } from '@/lib/auth';
import { getApprovalsInbox } from '@/lib/server/workspace-queries';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const filter = z.uuid().safeParse(params.agent);
  const { team, items, pendingCount, filterAgentId } = await getApprovalsInbox(
    filter.success ? filter.data : null,
  );
  const pending = items.filter((item) => item.status === 'pending');
  const resolved = items.filter((item) => item.status !== 'pending');

  return (
    <div className="app-shell" data-testid="approvals-page">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="header-inner">
          <Link href="/" className="brand" aria-label="Orbit home">
            <Image src="/icon.svg" alt="" width="34" height="34" />
            <span>Orbit</span>
          </Link>
          <span className="header-slash" aria-hidden="true">
            /
          </span>
          <span className="workspace-name">Private workspace</span>
          <span className="workspace-badge">Admin</span>
          <div className="header-actions">
            <ThemeSwitch />
          </div>
        </div>
        <nav className="workspace-nav" aria-label="Workspace">
          <div className="nav-inner">
            <Link href="/">Overview</Link>
            <Link href="/#agents">Agents</Link>
            <Link href="/approvals" aria-current="page">
              Approvals
              {pendingCount > 0 && <span className="tab-count">{pendingCount}</span>}
            </Link>
            <Link href="/templates">Templates</Link>
          </div>
        </nav>
      </header>
      <main id="main" className="dashboard approvals-dashboard">
        <div className="page-heading">
          <div>
            <h1>Approvals</h1>
            <p className="muted">
              Review suspended proposals newest first. Approve, edit then approve, or reject.
            </p>
          </div>
          <span className="runtime-status" aria-live="polite">
            {pendingCount} pending
          </span>
        </div>

        <ApprovalsFilter agents={team} filterAgentId={filterAgentId} />
        <ApprovalsInbox pending={pending} resolved={resolved} />
      </main>
    </div>
  );
}
