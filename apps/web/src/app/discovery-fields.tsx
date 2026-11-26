'use client';

import { useMemo, useState, useTransition } from 'react';

import { Loader, Plus, Radar, Trash2 } from 'lucide-react';

import { previewXDiscoveryQuery } from '@/actions/discovery';
import { DiscoveryFilterFields } from '@/app/discovery-filter-fields';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { discoveryCostHint } from '@/lib/runtime/x/discovery-cost';
import type { DiscoveryFilters } from '@/lib/runtime/x/discovery-filters';

type QueryRow = { id: string; value: string };

type PreviewPost = {
  id: string;
  text: string;
  authorUsername?: string;
  relevant: boolean;
  matchedTerms: string[];
  filterPass: boolean;
  filterReasons: string[];
};

function newRow(value = ''): QueryRow {
  return { id: crypto.randomUUID(), value };
}

export function DiscoveryFields({
  agentId,
  initialQueries,
  initialPaused,
  initialMaxPosts,
  initialFilters,
  prefix,
}: {
  agentId?: string;
  initialQueries: string[];
  initialPaused: boolean;
  initialMaxPosts: number;
  initialFilters: DiscoveryFilters;
  prefix: string;
}) {
  const [queries, setQueries] = useState<QueryRow[]>(() =>
    (initialQueries.length ? initialQueries : ['']).map((value) => newRow(value)),
  );
  const [paused, setPaused] = useState(initialPaused);
  const [maxPosts, setMaxPosts] = useState(initialMaxPosts);
  const [previewQuery, setPreviewQuery] = useState('');
  const [preview, setPreview] = useState<PreviewPost[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const filledQueries = useMemo(
    () => queries.map((row) => row.value.trim()).filter(Boolean),
    [queries],
  );
  const costHint = discoveryCostHint({
    queryCount: filledQueries.length,
    maxPostsPerPoll: maxPosts,
    paused,
  });

  function runPreview(query: string) {
    if (!agentId) {
      setPreviewError('Save the agent first, then test a query.');
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setPreviewError('Enter a query to preview.');
      return;
    }
    setPreviewQuery(trimmed);
    setPreviewError(null);
    setPreview(null);
    setPreviewMeta(null);
    startTransition(async () => {
      const form = new FormData();
      form.set('agentId', agentId);
      form.set('query', trimmed);
      form.set('maxPosts', String(maxPosts));
      const filtersField = document.querySelector<HTMLInputElement>(
        `input[name="xDiscoveryFilters"]`,
      );
      if (filtersField?.value) form.set('xDiscoveryFilters', filtersField.value);
      const result = await previewXDiscoveryQuery(form);
      if (result.error) {
        setPreviewError(result.error);
        return;
      }
      setPreview(result.posts ?? []);
      setPreviewMeta(result.message ?? null);
    });
  }

  return (
    <div className="discovery-fields">
      <input type="hidden" name="xDiscoveryPaused" value={paused ? 'true' : 'false'} />
      {filledQueries.map((query) => (
        <input key={`hidden-${query}`} type="hidden" name="xSearchQuery" value={query} />
      ))}

      <Field
        orientation="horizontal"
        className="discovery-pause-row items-center justify-between gap-4"
      >
        <div className="space-y-1">
          <FieldLabel htmlFor={`${prefix}-x-discovery-paused`}>Polling</FieldLabel>
          <FieldDescription>
            When paused, queries stay saved but Orbit does not call X until you resume.
          </FieldDescription>
        </div>
        <Switch
          id={`${prefix}-x-discovery-paused`}
          checked={!paused}
          onCheckedChange={(enabled) => {
            setPaused(!enabled);
          }}
          aria-label="X discovery polling"
        />
      </Field>

      <Field>
        <FieldLabel htmlFor={`${prefix}-x-discovery-max-posts`}>Posts per poll</FieldLabel>
        <Input
          id={`${prefix}-x-discovery-max-posts`}
          name="xDiscoveryMaxPostsPerPoll"
          type="number"
          min={1}
          max={50}
          value={maxPosts}
          onChange={(event) => {
            const next = Number(event.target.value);
            setMaxPosts(Number.isFinite(next) ? next : 10);
          }}
          className="max-w-[140px]"
        />
        <FieldDescription>Hard cap across all queries for each poll cycle (1–50).</FieldDescription>
      </Field>

      <DiscoveryFilterFields prefix={prefix} initial={initialFilters} />

      <div className="discovery-query-list" role="group" aria-label="X search queries">
        {queries.map((row, index) => (
          <div key={row.id} className="discovery-query-row">
            <Field className="min-w-0 flex-1">
              <FieldLabel htmlFor={`${prefix}-x-query-${row.id}`}>
                Search query {queries.length > 1 ? index + 1 : ''}
              </FieldLabel>
              <Input
                id={`${prefix}-x-query-${row.id}`}
                value={row.value}
                maxLength={512}
                placeholder='e.g. "product launch" OR founder -is:retweet lang:en'
                onChange={(event) => {
                  const value = event.target.value;
                  setQueries((current) =>
                    current.map((entry) => (entry.id === row.id ? { ...entry, value } : entry)),
                  );
                }}
              />
            </Field>
            <div className="discovery-query-actions">
              {agentId && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending || !row.value.trim()}
                  onClick={() => {
                    runPreview(row.value);
                  }}
                >
                  {pending && previewQuery === row.value.trim() ? (
                    <Loader size={14} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Radar size={14} aria-hidden="true" />
                  )}
                  Test query
                </Button>
              )}
              {queries.length > 1 && (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove query ${index + 1}`}
                  onClick={() => {
                    setQueries((current) => {
                      const next = current.filter((entry) => entry.id !== row.id);
                      return next.length ? next : [newRow()];
                    });
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {queries.length < 10 && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setQueries((current) => [...current, newRow()]);
          }}
        >
          <Plus size={14} aria-hidden="true" />
          Add query
        </Button>
      )}

      <p className="field-hint discovery-cost-hint">{costHint}</p>
      <p className="field-hint">
        Filters run before the relevance pre-filter and model evaluation. Test query shows which
        sample posts pass or fail and why.
      </p>

      {previewError && (
        <p className="form-error" role="alert">
          {previewError}
        </p>
      )}
      {previewMeta && (
        <p className="muted" role="status">
          {previewMeta}
        </p>
      )}
      {preview && (
        <div className="discovery-preview" aria-live="polite">
          <h3>Preview (not saved)</h3>
          {!preview.length ? (
            <p className="muted">No sample matches for this query right now.</p>
          ) : (
            <ul>
              {preview.map((post) => {
                const status = !post.filterPass
                  ? 'Filtered'
                  : post.relevant
                    ? 'Would evaluate'
                    : 'Would skip';
                return (
                  <li
                    key={post.id}
                    data-relevant={post.filterPass && post.relevant ? true : undefined}
                    data-filtered={!post.filterPass ? true : undefined}
                  >
                    <div className="discovery-preview-meta">
                      <span>{post.authorUsername ? `@${post.authorUsername}` : post.id}</span>
                      <span className="state-label">{status}</span>
                    </div>
                    <p>{post.text}</p>
                    {!post.filterPass && post.filterReasons.length > 0 && (
                      <p className="muted">Filter: {post.filterReasons.join(' ')}</p>
                    )}
                    {post.filterPass && post.matchedTerms.length > 0 && (
                      <p className="muted">Matched: {post.matchedTerms.join(', ')}</p>
                    )}
                    {post.filterPass && !post.relevant && (
                      <p className="muted">
                        Relevance: no overlap with mission or engagement criteria.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
