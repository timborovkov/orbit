import Image from 'next/image';
import Link from 'next/link';
import { ArrowDownLeft, CirclePause, LockKeyhole, ShieldCheck, Users } from 'lucide-react';

import { logout } from '@/actions/auth';
import { setGlobalPause } from '@/actions/controls';
import { AgentAvatar } from '@/app/agent-avatar';
import { CreateAgent } from '@/app/create-agent';
import { ThemeSwitch } from '@/app/theme';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { SubmitButton } from '@/components/ui/submit-button';
import { env } from '@/lib/env';
import { formatUtcTimestamp } from '@/lib/format';
import { getOverview } from '@/lib/server/workspace-queries';

export const dynamic = 'force-dynamic';
export default async function Home() {
  const { email, team, events, state, presets } = await getOverview();
  const paused = state.at(0)?.paused ?? true;
  const localAuth = env().AUTH_DISABLED;
  return (
    <div className="app-shell">
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
            {!localAuth && (
              <form action={logout}>
                <SubmitButton variant="ghost" size="sm" pendingLabel="Signing out…">
                  Sign out
                </SubmitButton>
              </form>
            )}
          </div>
        </div>
        <nav className="workspace-nav" aria-label="Workspace">
          <div className="nav-inner">
            <Link href="/" aria-current="page">
              Overview
            </Link>
            <a href="#agents">Agents</a>
            <a href="#activity">Activity</a>
            <Link href="/templates">Templates</Link>
            <a href="#controls">Controls</a>
          </div>
        </nav>
      </header>
      <main id="main" className="dashboard">
        {localAuth && (
          <p className="local-auth-notice" role="status">
            Authentication disabled · Local development · {email}
          </p>
        )}
        <div className="page-heading">
          <div>
            <h1>Overview</h1>
            <p className="muted">Manage your agents and workspace activity.</p>
          </div>
          <span className="runtime-status">
            <span className="status-dot" />
            Worker queue available
          </span>
        </div>
        <dl className="metrics" aria-label="Agent summary">
          <div>
            <dt>Total agents</dt>
            <dd>
              {team.length}
              <span>in this workspace</span>
            </dd>
          </div>
          <div>
            <dt>Shadow</dt>
            <dd>
              {team.filter((a) => a.lifecycle === 'shadow').length}
              <span>writes suppressed</span>
            </dd>
          </div>
          <div>
            <dt>Live</dt>
            <dd>
              {team.filter((a) => a.lifecycle === 'live').length}
              <span>adapters still gated</span>
            </dd>
          </div>
        </dl>
        <div className="workspace-grid">
          <div className="primary-column">
            <section className="surface" id="agents" aria-labelledby="agents-title">
              <div className="section-heading">
                <div className="section-label">
                  <h2 id="agents-title">Agents</h2>
                  <span className="count">{team.length}</span>
                </div>
                <CreateAgent
                  templates={presets.map((t) => ({
                    id: t.id,
                    title: t.title,
                    mission: t.config.mission,
                  }))}
                />
              </div>
              {team.length ? (
                <div className="agent-table-wrap">
                  <table className="agent-table">
                    <caption className="sr-only">Agents in your workspace</caption>
                    <thead>
                      <tr>
                        <th scope="col">Agent</th>
                        <th scope="col">Lifecycle</th>
                      </tr>
                    </thead>
                    <tbody>
                      {team.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <div className="agent-identity">
                              <AgentAvatar id={a.id} name={a.name} pictureKey={a.pictureKey} />
                              <div>
                                <h3>
                                  <Link href={`/agents/${a.id}`}>
                                    <bdi>{a.name}</bdi>
                                  </Link>
                                </h3>
                                <p className="agent-mission">{a.mission}</p>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="status-label">
                              <span className="status-dot" />
                              {a.lifecycle}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty className="empty-state border-0 py-10 md:py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Users size={22} strokeWidth={1.5} aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>No agents yet</EmptyTitle>
                    <EmptyDescription>
                      Create an agent to define its identity and mission. New agents start in shadow
                      mode, with external writes suppressed.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              <div className="section-footnote">
                <LockKeyhole size={13} />
                <span>
                  Open an agent to configure lifecycle, budgets and simulations. An optional server
                  OpenRouter key covers agents without their own credential. External actions remain
                  suppressed until adapters ship.
                </span>
              </div>
            </section>
            <section
              id="controls"
              className="surface control-panel"
              aria-labelledby="controls-title"
            >
              <div className="control-title">
                <ShieldCheck size={18} strokeWidth={1.5} />
                <h2 id="controls-title">Outbound controls</h2>
                <span className="control-status">{paused ? 'Paused' : 'Released'}</span>
              </div>
              <div className="control-body">
                <div>
                  <h3>Global pause</h3>
                  <p className="muted">Stop outbound activity across all agents.</p>
                </div>
                <form action={setGlobalPause}>
                  <input type="hidden" name="paused" value={paused ? 'false' : 'true'} />
                  <SubmitButton variant="outline" pendingLabel="Saving…">
                    {paused ? <ArrowDownLeft size={15} /> : <CirclePause size={15} />}{' '}
                    {paused ? 'Release global pause' : 'Pause all outbound actions'}
                  </SubmitButton>
                </form>
              </div>
              <p className="control-note">
                The policy gateway enforces this pause before any external write would dispatch.
              </p>
            </section>
          </div>
          <section className="activity-panel" id="activity" aria-labelledby="activity-title">
            <div className="section-heading">
              <h2 id="activity-title">Recent activity</h2>
              <span className="muted text-small">Latest {events.length}</span>
            </div>
            <ol className="activity-list">
              {events.map((e) => (
                <li key={e.id}>
                  <span className="timeline-dot" aria-hidden="true" />
                  <div>
                    <p className="activity-action">{e.action}</p>
                    <p className="activity-actor">{e.actor}</p>
                    <time dateTime={e.createdAt.toISOString()}>
                      {formatUtcTimestamp(e.createdAt)}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
            {!events.length && (
              <Empty className="activity-empty border-0 p-0 md:p-0">
                <EmptyHeader>
                  <EmptyTitle className="text-sm font-medium">No workspace activity yet</EmptyTitle>
                  <EmptyDescription>
                    Agent creation, lifecycle changes and reviews will show up here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </section>
        </div>
        <footer className="app-footer">
          <span>
            Orbit <span className="footer-divider">/</span> Private workspace
          </span>
          <bdi className="footer-account">{email}</bdi>
        </footer>
      </main>
    </div>
  );
}
