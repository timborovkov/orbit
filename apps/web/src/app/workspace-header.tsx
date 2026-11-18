import Image from 'next/image';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { ThemeSwitch } from '@/app/theme';

export function WorkspaceHeader({
  name,
  pendingApprovalCount = 0,
}: {
  name: string;
  pendingApprovalCount?: number;
}) {
  return (
    <header className="agent-header">
      <div className="agent-header-inner">
        <Link href="/" className="brand" aria-label="Orbit home">
          <Image src="/icon.svg" width={28} height={28} alt="" />
          <span>Orbit</span>
        </Link>
        <nav className="agent-breadcrumb" aria-label="Breadcrumb">
          <ChevronRight size={14} aria-hidden="true" />
          <Link href="/" aria-label="All agents">
            Agents
          </Link>
          <ChevronRight size={14} aria-hidden="true" />
          <span aria-current="page">{name}</span>
        </nav>
        <div className="header-actions">
          <Link href="/approvals" className="templates-link">
            Approvals
            {pendingApprovalCount > 0 && <span className="tab-count">{pendingApprovalCount}</span>}
          </Link>
          <Link href="/templates" className="templates-link">
            Templates
          </Link>
          <ThemeSwitch />
        </div>
      </div>
    </header>
  );
}
