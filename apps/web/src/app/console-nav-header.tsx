'use client';

import { usePathname } from 'next/navigation';

import { WorkspaceHeader, type WorkspaceNavHref } from '@/app/workspace-header';

const navHrefs: WorkspaceNavHref[] = [
  '/',
  '/approvals',
  '/people',
  '/evaluations',
  '/templates',
  '/knowledge',
  '/skills',
  '/mcp',
];

function currentFromPath(pathname: string): WorkspaceNavHref | undefined {
  if (pathname === '/') return '/';
  return navHrefs.find((href) => href !== '/' && pathname.startsWith(href));
}

export function ConsoleNavHeader({
  pendingApprovalCount,
  authDisabled,
}: {
  pendingApprovalCount: number;
  authDisabled: boolean;
}) {
  const pathname = usePathname();
  return (
    <WorkspaceHeader
      current={currentFromPath(pathname)}
      pendingApprovalCount={pendingApprovalCount}
      authDisabled={authDisabled}
    />
  );
}
