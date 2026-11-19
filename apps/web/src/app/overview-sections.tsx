import type { ReactNode } from 'react';

import { LoadingStatus } from '@/app/loading-status';

const metricLabels = ['Total agents', 'Shadow', 'Live'];

export function OverviewMetrics({ counts }: { counts?: [number, number, number] }) {
  return (
    <dl className="metrics" aria-label="Agent summary" aria-hidden={counts ? undefined : true}>
      {metricLabels.map((label, index) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{counts ? counts[index] : <span className="overview-placeholder" />}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AgentTable({ children, loading }: { children: ReactNode; loading?: boolean }) {
  return (
    <div className="agent-table-wrap" inert={loading}>
      <table className="agent-table">
        <caption className="sr-only">Agents in your workspace</caption>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Lifecycle</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <>
      <OverviewMetrics />
      <div className="workspace-grid">
        <div className="primary-column">
          <section className="surface" id="agents" aria-labelledby="agents-title">
            <div className="section-heading">
              <h2 id="agents-title">Agents</h2>
              <LoadingStatus>Loading overview…</LoadingStatus>
            </div>
            <AgentTable loading>
              {[0, 1, 2].map((row) => (
                <tr key={row}>
                  <td>
                    <div className="agent-identity">
                      <span className="avatar overview-placeholder" />
                      <div className="overview-agent-placeholder">
                        <span className="overview-placeholder w-24" />
                        <span className="overview-placeholder w-full" />
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="overview-placeholder mt-1 w-12" />
                  </td>
                </tr>
              ))}
            </AgentTable>
          </section>
        </div>
        <section className="activity-panel" id="activity" aria-labelledby="activity-title">
          <div className="section-heading">
            <h2 id="activity-title">Recent activity</h2>
          </div>
          <ol className="activity-list" aria-hidden="true">
            {[0, 1, 2].map((row) => (
              <li key={row}>
                <span className="timeline-dot" />
                <div className="overview-activity-placeholder">
                  <span className="overview-placeholder w-32" />
                  <span className="overview-placeholder w-40" />
                  <span className="overview-placeholder w-24" />
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
