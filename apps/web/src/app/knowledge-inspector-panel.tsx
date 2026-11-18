'use client';

import { Search } from 'lucide-react';

import type { InspectionHit } from '@/app/knowledge-shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';

export function KnowledgeInspectorPanel({
  query,
  pending,
  searching,
  inspection,
  onQueryChange,
  onInspect,
}: {
  query: string;
  pending: boolean;
  searching: boolean;
  inspection: {
    query: string;
    hits: InspectionHit[];
    embeddingMode: 'openrouter' | 'stub';
  } | null;
  onQueryChange: (value: string) => void;
  onInspect: () => void;
}) {
  return (
    <section className="knowledge-inspector" aria-labelledby="knowledge-inspector-title">
      <div className="editor-section-heading">
        <h2 id="knowledge-inspector-title">Retrieval inspector</h2>
        <p className="muted">
          Run a hybrid search against this agent’s ready chunks and inspect scores and citations.
        </p>
      </div>

      <form
        className="knowledge-inspector-form"
        onSubmit={(event) => {
          event.preventDefault();
          onInspect();
        }}
      >
        <label className="sr-only" htmlFor="knowledge-query">
          Query
        </label>
        <div className="knowledge-inspector-query">
          <Input
            id="knowledge-query"
            name="query"
            maxLength={2000}
            value={query}
            onChange={(event) => {
              onQueryChange(event.currentTarget.value);
            }}
            placeholder="Ask about a product detail, policy or FAQ…"
            disabled={searching}
            className="knowledge-inspector-query-input"
          />
          <Button
            type="submit"
            variant="default"
            size="sm"
            disabled={pending || !query.trim()}
            aria-disabled={pending || !query.trim()}
            className="knowledge-inspector-query-button"
          >
            {searching ? 'Searching…' : 'Inspect'}
          </Button>
        </div>
      </form>

      {!inspection ? (
        <div className="knowledge-inspector-empty">
          <Search size={24} aria-hidden="true" />
          <p>Enter a query to see ranked passages, vector/text scores and why they matched.</p>
        </div>
      ) : (
        <div className="knowledge-results">
          <div className="knowledge-results-header">
            <h3>
              {inspection.hits.length
                ? `Found ${inspection.hits.length} passage${inspection.hits.length === 1 ? '' : 's'}`
                : 'No matching passages'}
            </h3>
            {inspection.embeddingMode === 'stub' && (
              <Badge variant="secondary">Dev stub embeddings</Badge>
            )}
          </div>
          {!inspection.hits.length ? (
            <div className="knowledge-inspector-empty">
              <Search size={24} aria-hidden="true" />
              <p>
                No passages matched “{inspection.query}”. Try different wording or wait for ready
                documents.
              </p>
            </div>
          ) : (
            <ul className="knowledge-hit-list">
              {inspection.hits.map((hit, index) => (
                <li key={hit.chunkId} className="knowledge-hit">
                  <div className="knowledge-hit-header">
                    <div className="knowledge-hit-title">
                      <strong>{hit.sourceTitle}</strong>
                      <span className="knowledge-hit-rank">#{index + 1}</span>
                    </div>
                    <span className="knowledge-hit-score">{hit.rankScore.toFixed(3)}</span>
                  </div>
                  <div className="knowledge-hit-badges">
                    {hit.vectorScore !== null && (
                      <Badge variant="outline">Vector {hit.vectorScore.toFixed(3)}</Badge>
                    )}
                    {hit.textScore !== null && (
                      <Badge variant="outline">Text {hit.textScore.toFixed(3)}</Badge>
                    )}
                  </div>
                  <pre className="knowledge-hit-content">{hit.content}</pre>
                  <Collapsible className="knowledge-hit-details">
                    <CollapsibleTrigger className="knowledge-hit-details-trigger">
                      Details
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <dl className="knowledge-hit-detail-list">
                        <div>
                          <dt>Source</dt>
                          <dd>{hit.sourceFilename}</dd>
                        </div>
                        {hit.section && (
                          <div>
                            <dt>Section</dt>
                            <dd>{hit.section}</dd>
                          </div>
                        )}
                        {hit.page !== null && (
                          <div>
                            <dt>Page</dt>
                            <dd>{hit.page}</dd>
                          </div>
                        )}
                        <div>
                          <dt>Offsets</dt>
                          <dd>
                            {hit.startOffset}–{hit.endOffset}
                          </dd>
                        </div>
                        {hit.reasons.length > 0 && (
                          <div>
                            <dt>Match</dt>
                            <dd>{hit.reasons.join(' · ')}</dd>
                          </div>
                        )}
                      </dl>
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
