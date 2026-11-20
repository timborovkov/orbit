import Image from 'next/image';
import Link from 'next/link';

import { LogOut, Menu } from 'lucide-react';

import { logout } from '@/actions/auth';
import { ThemeSwitch } from '@/app/theme';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SubmitButton } from '@/components/ui/submit-button';
import { env } from '@/lib/env';

const navLinks = [
  { href: '/', label: 'Overview' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/evaluations', label: 'Evaluations' },
  { href: '/templates', label: 'Templates' },
  { href: '/skills', label: 'Skills' },
  { href: '/mcp', label: 'MCP' },
] as const;

export function WorkspaceHeader({
  current,
  pendingApprovalCount,
}: {
  current?: (typeof navLinks)[number]['href'];
  pendingApprovalCount: number;
}) {
  const links = navLinks.map(({ href, label }) => (
    <Link key={href} href={href} aria-current={href === current ? 'page' : undefined}>
      {label}
      {href === '/approvals' && pendingApprovalCount > 0 && (
        <>
          <span className="tab-count" aria-hidden="true">
            {pendingApprovalCount}
          </span>
          <span className="sr-only"> ({pendingApprovalCount} pending)</span>
        </>
      )}
    </Link>
  ));

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="workspace-header">
        <div className="workspace-header-inner">
          <Link href="/" className="brand" aria-label="Orbit home">
            <Image src="/icon.svg" alt="" width={28} height={28} />
            <span>Orbit</span>
          </Link>
          <span className="workspace-name">Private workspace</span>
          <div className="header-actions">
            <ThemeSwitch />
            {!env().AUTH_DISABLED && (
              <form action={logout}>
                <SubmitButton
                  variant="ghost"
                  size="sm"
                  className="workspace-sign-out"
                  pendingLabel="Signing out…"
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut size={16} aria-hidden="true" />
                  <span>Sign out</span>
                </SubmitButton>
              </form>
            )}
            <div className="workspace-nav-compact">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Workspace navigation"
                  >
                    <Menu size={20} aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="library-menu workspace-nav-menu">
                  {links.map((link) => (
                    <DropdownMenuItem key={link.key} asChild>
                      {link}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
        <nav className="workspace-nav" aria-label="Workspace">
          <div className="workspace-header-inner workspace-nav-inner">{links}</div>
        </nav>
      </header>
    </>
  );
}
