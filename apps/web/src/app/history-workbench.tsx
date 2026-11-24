'use client';

import { useMemo, useState } from 'react';

import Link from 'next/link';

import { ChevronDown, History } from 'lucide-react';

import { type ActivityEventRow, ActivityTimeline } from '@/app/activity-timeline';
import { ResearchActivity, type WebResearchActivity } from '@/app/research-activity';
import { RunContent } from '@/app/run-content';
import { SaveRunCaseForm } from '@/app/save-evaluation-case-form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatUtcTimestamp } from '@/lib/format';
import {
  defaultHistoryFilters,
  filterHistoryRuns,
  groupHistoryByDay,
  type HistoryFilters,
  type HistoryFilterStatus,
  uniqueHistorySources,
} from '@/lib/runtime/history-filters';
import type { getAgentWorkspace } from '@/lib/server/workspace-queries';

type WorkspaceHistory = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>['history'];
type WorkspaceVersions = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>['versions'];

const statusOptions: { value: HistoryFilterStatus; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'awaiting_approval', label: 'Awaiting approval' },
  { value: 'deferred', label: 'Deferred' },
  { value: 'interrupted', label: 'Interrupted' },
];

export function HistoryWorkbench({
  agentId,
  history,
  versions,
  activityEvents,
  webResearch,
  focusRunId,
}: {
  agentId: string;
  history: WorkspaceHistory;
  versions: WorkspaceVersions;
  activityEvents: ActivityEventRow[];
  webResearch: WebResearchActivity;
  focusRunId?: string;
}) {
  const versionFor = (configurationId: string) =>
    versions.find((version) => version.id === configurationId)?.version ?? '—';
  const [filters, setFilters] = useState<HistoryFilters>(defaultHistoryFilters);
  const sources = useMemo(() => uniqueHistorySources(history), [history]);
  const filtered = useMemo(() => filterHistoryRuns(history, filters), [history, filters]);
  const groups = useMemo(() => groupHistoryByDay(filtered), [filtered]);

  return (
    <div className="history-workbench">
      <div className="history-primary">
        {activityEvents.length > 0 && <ActivityTimeline events={activityEvents} />}
        <section id="history">
          <div className="editor-section-heading">
            <h2>Runs</h2>
            <p className="muted">
              Agent runs and Playground simulations, with evaluator reasoning, proposed actions and
              the configuration each one used.
            </p>
          </div>

          {history.length > 0 && (
            <div className="history-filters" role="group" aria-label="Filter runs">
              <Select
                value={filters.status}
                onValueChange={(value) => {
                  setFilters((current) => ({
                    ...current,
                    status: value as HistoryFilterStatus,
                  }));
                }}
              >
                <SelectTrigger aria-label="Filter by status" className="history-filter-control">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={filters.source}
                onValueChange={(value) => {
                  setFilters((current) => ({ ...current, source: value }));
                }}
              >
                <SelectTrigger aria-label="Filter by source" className="history-filter-control">
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  {sources.map((source) => (
                    <SelectItem key={source} value={source}>
                      {source}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={filters.configurationId}
                onValueChange={(value) => {
                  setFilters((current) => ({ ...current, configurationId: value }));
                }}
              >
                <SelectTrigger
                  aria-label="Filter by configuration version"
                  className="history-filter-control"
                >
                  <SelectValue placeholder="Version" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All versions</SelectItem>
                  {versions.map((version) => (
                    <SelectItem key={version.id} value={version.id}>
                      Version {version.version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {!history.length && (
            <div className="history-empty">
              <History size={24} aria-hidden="true" />
              <p>No runs yet. Start in the Playground or connect a channel.</p>
            </div>
          )}
          {history.length > 0 && !filtered.length && (
            <div className="history-empty">
              <History size={24} aria-hidden="true" />
              <p>No runs match these filters.</p>
            </div>
          )}

          {groups.map((group) => (
            <div key={group.dayKey} className="history-day-group">
              <h3 className="history-day-heading">{group.label}</h3>
              {group.runs.map((run) => (
                <details
                  key={run.id}
                  id={`run-${run.id}`}
                  className="run-detail"
                  open={run.id === focusRunId ? true : undefined}
                  data-origin={run.origin}
                >
                  <summary>
                    <div>
                      <span className="run-title" title={run.sourceTitle}>
                        {run.sourceTitle}
                      </span>
                      <time dateTime={run.createdAt.toISOString()}>
                        {formatUtcTimestamp(run.createdAt)} · {run.channelName} · Version{' '}
                        {versionFor(run.configurationId)}
                        {run.job && run.job.status !== 'completed'
                          ? ` · job ${run.job.status}`
                          : ''}
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
            </div>
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
                  <dd>
                    {typeof value === 'string'
                      ? value || '—'
                      : Array.isArray(value)
                        ? value.join(', ') || '—'
                        : typeof value === 'boolean' || typeof value === 'number'
                          ? String(value)
                          : '—'}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        ))}
      </section>
    </div>
  );
}
