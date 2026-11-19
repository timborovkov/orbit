'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, Menu } from 'lucide-react';

import { ThemeSwitch } from '@/app/theme';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const navLinks = [
  { href: '/approvals', label: 'Approvals' },
  { href: '/templates', label: 'Templates' },
  { href: '/skills', label: 'Skills' },
  { href: '/mcp', label: 'MCP' },
] as const;

export function WorkspaceHeader({
  name,
  pendingApprovalCount = 0,
}: {
  name: string;
  pendingApprovalCount?: number;
}) {
  const pathname = usePathname();
  const underAgents = pathname.startsWith('/agents/');

  return (
    <header className="agent-header">
      <div className="agent-header-inner">
        <Link href="/" className="brand" aria-label="Orbit home">
          <Image src="/icon.svg" width={28} height={28} alt="" />
          <span>Orbit</span>
        </Link>
        <nav className="agent-breadcrumb" aria-label="Breadcrumb">
          {underAgents ? (
            <>
              <ChevronRight size={14} aria-hidden="true" />
              <Link href="/" aria-label="All agents">
                Agents
              </Link>
              <ChevronRight size={14} aria-hidden="true" className="breadcrumb-sep" />
              <span aria-current="page">{name}</span>
            </>
          ) : (
            <>
              <ChevronRight size={14} aria-hidden="true" />
              <span aria-current="page">{name}</span>
            </>
          )}
        </nav>
        <div className="header-actions">
          <div className="header-nav-desktop">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="templates-link"
                aria-current={
                  pathname === link.href || pathname.startsWith(`${link.href}/`)
                    ? 'page'
                    : undefined
                }
              >
                {link.label}
                {link.href === '/approvals' && pendingApprovalCount > 0 && (
                  <span className="tab-count">{pendingApprovalCount}</span>
                )}
              </Link>
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="header-nav-mobile"
                aria-label="Workspace navigation"
              >
                <Menu size={18} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="library-menu">
              <DropdownMenuItem asChild>
                <Link href="/">Agents</Link>
              </DropdownMenuItem>
              {navLinks.map((link) => (
                <DropdownMenuItem key={link.href} asChild>
                  <Link href={link.href}>
                    {link.label}
                    {link.href === '/approvals' && pendingApprovalCount > 0
                      ? ` (${pendingApprovalCount})`
                      : ''}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <ThemeSwitch />
        </div>
      </div>
    </header>
  );
}
