import { Suspense } from 'react';
import Link from 'next/link';
import { ArrowDownLeft, CirclePause, ShieldCheck, Users } from 'lucide-react';

import { setGlobalPause } from '@/actions/controls';
import { AgentAvatar } from '@/app/agent-avatar';
import { CreateAgent } from '@/app/create-agent';
import { AgentTable, OverviewMetrics, OverviewSkeleton } from '@/app/overview-sections';
import { WorkspaceHeader } from '@/app/workspace-header';
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

type OverviewData = Awaited<ReturnType<typeof getOverview>>['data'];

export default async function Home() {
  const { email, pendingApprovalCount, data } = await getOverview();
  return (
    <div className="app-shell">
      <Suspense fallback={<WorkspaceHeader current="/" pendingApprovalCount={0} />}>
        <OverviewHeader pendingApprovalCount={pendingApprovalCount} />
      </Suspense>
      <main id="main" tabIndex={-1} className="workspace-main">
        {env().AUTH_DISABLED && (
          <p className="local-auth-notice" role="status">
            Authentication disabled · Local development · {email}
          </p>
        )}
        <div className="page-heading">
          <div>
            <h1>Overview</h1>
            <p className="muted">
              Manage your agents and workspace activity. External writes are suppressed in all
              modes.
            </p>
          </div>
        </div>
        <Suspense fallback={<OverviewSkeleton />}>
          <OverviewContent email={email} data={data} />
        </Suspense>
      </main>
    </div>
  );
}

async function OverviewHeader({ pendingApprovalCount }: { pendingApprovalCount: Promise<number> }) {
  return <WorkspaceHeader current="/" pendingApprovalCount={await pendingApprovalCount} />;
}

async function OverviewContent({ email, data }: { email: string; data: OverviewData }) {
  const { team, events, state, presets } = await data;
  const paused = state.at(0)?.paused ?? true;

  return (
    <>
      <OverviewMetrics
        counts={[
          team.length,
          team.filter((agent) => agent.lifecycle === 'shadow').length,
          team.filter((agent) => agent.lifecycle === 'live').length,
        ]}
      />
      <div className="workspace-grid">
        <div className="primary-column">
          <section className="surface" id="agents" aria-labelledby="agents-title">
            <div className="section-heading">
              <h2 id="agents-title">Agents</h2>
              <CreateAgent
                templates={presets.map((t) => ({
                  id: t.id,
                  title: t.title,
                  mission: t.config.mission,
                }))}
              />
            </div>
            {team.length ? (
              <AgentTable>
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
              </AgentTable>
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
          </section>
          <section id="controls" className="surface control-panel" aria-labelledby="controls-title">
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
    </>
  );
}
