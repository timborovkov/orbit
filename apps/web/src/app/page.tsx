import Image from 'next/image';
import Link from 'next/link';
import { desc } from 'drizzle-orm';
import { ArrowDownLeft, CirclePause, LockKeyhole, ShieldCheck, Users } from 'lucide-react';

import { logout } from '@/actions/auth';
import { setGlobalPause } from '@/actions/controls';
import { CreateAgent } from '@/app/create-agent';
import { ThemeSwitch } from '@/app/theme';
import { SubmitButton } from '@/components/ui/submit-button';
import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { agents, audit, controls } from '@/lib/schema';

export const dynamic = 'force-dynamic';
export default async function Home() {
  const { email, team, events, state } = await requireAdmin().then(async (email) => {
    const [team, events, state] = await Promise.all([
      db().select().from(agents).orderBy(desc(agents.createdAt)),
      db().select().from(audit).orderBy(desc(audit.createdAt)).limit(12),
      db().select().from(controls),
    ]);
    return { email, team, events, state };
  });
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
            Execution not configured
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
            <dt>Paused</dt>
            <dd>
              {team.filter((a) => a.status === 'paused').length}
              <span>awaiting activation</span>
            </dd>
          </div>
          <div>
            <dt>Live mode</dt>
            <dd>
              {team.filter((a) => a.mode === 'live').length}
              <span>agents enabled</span>
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
                <CreateAgent />
              </div>
              {team.length ? (
                <div className="agent-table-wrap">
                  <table className="agent-table">
                    <caption className="sr-only">Agents in your workspace</caption>
                    <thead>
                      <tr>
                        <th scope="col">Agent</th>
                        <th scope="col">Status</th>
                        <th scope="col">Mode</th>
                      </tr>
                    </thead>
                    <tbody>
                      {team.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <div className="agent-identity">
                              <span className="avatar" aria-hidden="true">
                                {a.name.charAt(0).toUpperCase()}
                              </span>
                              <div>
                                <h3>
                                  <bdi>{a.name}</bdi>
                                </h3>
                                <p className="agent-mission">{a.mission}</p>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="status-label">
                              <span className="status-dot" />
                              {a.status}
                            </span>
                          </td>
                          <td>
                            <span className="mode-label">{a.mode}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty-state">
                  <span className="empty-icon">
                    <Users size={22} strokeWidth={1.5} />
                  </span>
                  <h3>No agents yet</h3>
                  <p>
                    Create an agent to define its identity and mission.
                    <br />
                    New agents start paused, with external writes disabled.
                  </p>
                </div>
              )}
              <div className="section-footnote">
                <LockKeyhole size={13} />
                <span>Agents remain paused until execution is configured.</span>
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
                This setting applies when agent execution becomes available.
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
                      {e.createdAt.toISOString().replace('T', ' ').slice(0, 16)} UTC
                    </time>
                  </div>
                </li>
              ))}
            </ol>
            {!events.length && <p className="activity-empty">No workspace activity yet.</p>}
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
