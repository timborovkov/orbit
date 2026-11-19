import { ChevronDown, History } from 'lucide-react';

import { RunContent } from '@/app/run-content';
import { SavePlaygroundCaseForm } from '@/app/save-evaluation-case-form';
import { formatUtcTimestamp } from '@/lib/format';
import type { getAgentWorkspace } from '@/lib/server/workspace-queries';

type Workspace = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>;

export function AgentHistoryPanel({
  agentId,
  history,
  versions,
  focusRunId,
  versionFor,
}: {
  agentId: string;
  history: Workspace['history'];
  versions: Workspace['versions'];
  focusRunId?: string;
  versionFor: (configurationId: string) => number | string;
}) {
  return (
    <div className="history-workbench">
      <section id="history">
        <div className="editor-section-heading">
          <h2>Run history</h2>
          <p className="muted">
            Your latest 50 simulations, with queue status, policy outcomes and the configuration
            each one used.
          </p>
        </div>
        {!history.length && (
          <div className="history-empty">
            <History size={24} aria-hidden="true" />
            <p>No runs yet. Start in the Playground to test your agent.</p>
          </div>
        )}
        {history.map((run) => (
          <details
            key={run.id}
            id={`run-${run.id}`}
            className="run-detail"
            open={run.id === focusRunId ? true : undefined}
          >
            <summary>
              <div>
                <span className="run-title">{run.input}</span>
                <time dateTime={run.createdAt.toISOString()}>
                  {formatUtcTimestamp(run.createdAt)} · Version {versionFor(run.configurationId)}
                  {run.job && run.job.status !== 'completed' ? ` · job ${run.job.status}` : ''}
                  {run.displayStatus !== 'deferred' && run.deferReason
                    ? ` · ${run.deferReason}`
                    : ''}
                </time>
              </div>
              <span className="state-label" title={run.deferReason ?? undefined}>
                {run.displayStatus === 'awaiting_approval'
                  ? 'Awaiting approval'
                  : run.displayStatus}
              </span>
              <ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" />
            </summary>
            <RunContent run={run} interrupted={run.interrupted} />
            <SavePlaygroundCaseForm
              agentId={agentId}
              runId={run.id}
              input={run.input}
              recipients={run.recipients}
              defaultTitle={run.input.slice(0, 80)}
            />
          </details>
        ))}
      </section>
      <section className="version-history">
        <h2>Configuration versions</h2>
        <p className="muted">Every save is a snapshot. Previous runs stay unchanged.</p>
        {versions.map((version) => (
          <details key={version.id}>
            <summary>
              <span>Version {version.version}</span>
              <time>{formatUtcTimestamp(version.createdAt)}</time>
            </summary>
            <dl className="config-snapshot">
              {Object.entries(version.config).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value || '—'}</dd>
                </div>
              ))}
            </dl>
          </details>
        ))}
      </section>
    </div>
  );
}
