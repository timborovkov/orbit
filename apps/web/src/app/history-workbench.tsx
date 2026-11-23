import Link from 'next/link';

import { ChevronDown, History } from 'lucide-react';

import { type ActivityEventRow, ActivityTimeline } from '@/app/activity-timeline';
import { ResearchActivity, type WebResearchActivity } from '@/app/research-activity';
import { RunContent } from '@/app/run-content';
import { SaveRunCaseForm } from '@/app/save-evaluation-case-form';
import { formatUtcTimestamp } from '@/lib/format';
import type { getAgentWorkspace } from '@/lib/server/workspace-queries';

type WorkspaceHistory = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>['history'];
type WorkspaceVersions = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>['versions'];

export function HistoryWorkbench({
  agentId,
  history,
  versions,
  activityEvents,
  webResearch,
  focusRunId,
  versionFor,
}: {
  agentId: string;
  history: WorkspaceHistory;
  versions: WorkspaceVersions;
  activityEvents: ActivityEventRow[];
  webResearch: WebResearchActivity;
  focusRunId?: string;
  versionFor: (configurationId: string) => number | string;
}) {
  return (
    <div className="history-workbench">
      <div className="history-primary">
        <ActivityTimeline events={activityEvents} />
        <section id="history">
          <div className="editor-section-heading">
            <h2>Activity timeline</h2>
            <p className="muted">
              Agent runs and Playground simulations, with evaluator reasoning, proposed actions and
              the configuration each one used.
            </p>
          </div>
          {!history.length && (
            <div className="history-empty">
              <History size={24} aria-hidden="true" />
              <p>No runs yet. Start in the Playground or connect a channel.</p>
            </div>
          )}
          {history.map((run) => (
            <details
              key={run.id}
              id={`run-${run.id}`}
              className="run-detail"
              open={run.id === focusRunId ? true : undefined}
              data-origin={run.origin}
            >
              <summary>
                <div>
                  <span className="run-title">{run.sourceTitle}</span>
                  <time dateTime={run.createdAt.toISOString()}>
                    {formatUtcTimestamp(run.createdAt)} · {run.channelName} · Version{' '}
                    {versionFor(run.configurationId)}
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
              {run.personId && (
                <Link className="person-source-link" href={`/people/${run.personId}`}>
                  View {run.channelName} author in People
                </Link>
              )}
              {run.sourceHref && (
                <Link className="person-source-link" href={run.sourceHref}>
                  {run.sourceLinkLabel}
                </Link>
              )}
              <RunContent
                run={run}
                interrupted={run.interrupted}
                preferDraftAnswer={run.preferDraftAnswer}
              />
              <ResearchActivity
                agentId={agentId}
                libraries={webResearch.libraries}
                crawls={webResearch.crawls.filter((item) => item.runId === run.id)}
                citations={webResearch.citations.filter((item) => item.runId === run.id)}
              />
              {run.status === 'completed' && (
                <SaveRunCaseForm
                  agentId={agentId}
                  runId={run.id}
                  defaultTitle={run.sourceTitle.slice(0, 80)}
                />
              )}
            </details>
          ))}
        </section>
      </div>
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
