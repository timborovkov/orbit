'use client';

import { useMemo, useState } from 'react';

import Link from 'next/link';

import { ChevronDown, History } from 'lucide-react';

import { type ActivityEventRow, ActivityTimeline } from '@/app/activity-timeline';
import { ResearchActivity, type WebResearchActivity } from '@/app/research-activity';
import { RunContent } from '@/app/run-content';
import { SaveRunCaseForm } from '@/app/save-evaluation-case-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatAge, formatUtcTimestamp } from '@/lib/format';
import {
  defaultHistoryFilters,
  filterHistoryRuns,
  groupHistoryByDay,
  type HistoryFilters,
  type HistoryFilterStatus,
  paginateHistoryRuns,
  sortHistoryRunsNewestFirst,
  uniqueHistorySources,
} from '@/lib/runtime/history-filters';
import type { getAgentWorkspace } from '@/lib/server/workspace-queries';
import { plainTextSnippet } from '@/lib/text/plain-snippet';

type WorkspaceHistory = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>['history'];
type WorkspaceVersions = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>['versions'];

const PAGE_SIZE = 20;

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

function statusLabel(status: string) {
  if (status === 'awaiting_approval') return 'Awaiting approval';
  return status;
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'completed') {
    return (
      <Badge className="border-transparent bg-emerald-600/15 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300">
        completed
      </Badge>
    );
  }
  if (status === 'failed' || status === 'interrupted') {
    return <Badge variant="destructive">{status}</Badge>;
  }
  if (status === 'awaiting_approval') {
    return <Badge variant="outline">Awaiting approval</Badge>;
  }
  return <Badge variant="secondary">{statusLabel(status)}</Badge>;
}

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
  const [page, setPage] = useState(1);
  const sources = useMemo(() => uniqueHistorySources(history), [history]);
  const filtered = useMemo(
    () => sortHistoryRunsNewestFirst(filterHistoryRuns(history, filters)),
    [history, filters],
  );
  const paged = useMemo(() => paginateHistoryRuns(filtered, page, PAGE_SIZE), [filtered, page]);
  const groups = useMemo(() => groupHistoryByDay(paged.items), [paged.items]);
  const now = useMemo(() => new Date(), []);

  function updateFilters(next: HistoryFilters) {
    setFilters(next);
    setPage(1);
  }

  return (
    <div className="history-workbench">
      <div className="history-primary">
        {activityEvents.length > 0 && <ActivityTimeline events={activityEvents} />}
        <section id="history">
          <div className="editor-section-heading">
            <h2>Runs</h2>
            <p className="muted">Playground and channel runs for this agent.</p>
          </div>

          {history.length > 0 && (
            <div className="history-filters" role="group" aria-label="Filter runs">
              <Select
                value={filters.status}
                onValueChange={(value) => {
                  updateFilters({ ...filters, status: value as HistoryFilterStatus });
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
                  updateFilters({ ...filters, source: value });
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
                  updateFilters({ ...filters, configurationId: value });
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

          <div className="history-run-list">
            {groups.map((group) => (
              <div key={group.dayKey} className="history-day-group">
                <h3 className="history-day-heading">{group.label}</h3>
                {group.runs.map((run) => {
                  const title = plainTextSnippet(run.sourceTitle, 100) || 'Untitled run';
                  const author = run.authorHandle ? plainTextSnippet(run.authorHandle, 40) : null;
                  return (
                    <details
                      key={run.id}
                      id={`run-${run.id}`}
                      className="run-detail history-run-row"
                      open={run.id === focusRunId ? true : undefined}
                      data-origin={run.origin}
                    >
                      <summary>
                        <div className="history-run-summary">
                          <div className="history-run-line">
                            <span className="history-run-source">{run.channelName}</span>
                            {author ? <span className="history-run-author">{author}</span> : null}
                            <span className="run-title" title={run.sourceTitle}>
                              {title}
                            </span>
                          </div>
                          <div className="history-run-status">
                            <StatusBadge status={run.displayStatus} />
                          </div>
                          <div className="history-run-meta">
                            <time
                              dateTime={run.createdAt.toISOString()}
                              title={formatUtcTimestamp(run.createdAt)}
                            >
                              {formatAge(run.createdAt, now)} ago
                            </time>
                            <span className="history-run-version">
                              v{versionFor(run.configurationId)}
                            </span>
                          </div>
                        </div>
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
                          defaultTitle={title.slice(0, 80)}
                        />
                      )}
                    </details>
                  );
                })}
              </div>
            ))}
          </div>

          {paged.totalPages > 1 ? (
            <nav className="history-pagination form-actions" aria-label="Run pages">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => {
                  setPage((current) => Math.max(1, current - 1));
                }}
              >
                Previous
              </Button>
              <span className="field-hint">
                Page {paged.page} of {paged.totalPages}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page >= paged.totalPages}
                onClick={() => {
                  setPage((current) => Math.min(paged.totalPages, current + 1));
                }}
              >
                Next
              </Button>
            </nav>
          ) : null}
        </section>
      </div>
      <section className="version-history">
        <h2>Versions</h2>
        <p className="muted">Snapshots used by past runs.</p>
        {versions.map((version) => (
          <details key={version.id} className="version-history-row">
            <summary>
              <span>v{version.version}</span>
              <time title={formatUtcTimestamp(version.createdAt)}>
                {formatAge(version.createdAt, now)} ago
              </time>
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
