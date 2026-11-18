'use client';

import { useRef, useState, useTransition } from 'react';
import { BookOpen, FileText, Search } from 'lucide-react';

import {
  deleteKnowledge,
  inspectKnowledge,
  replaceKnowledge,
  reprocessKnowledge,
  uploadKnowledge,
} from '@/actions/knowledge';
import { Button } from '@/components/ui/button';
import { formatUtcTimestamp } from '@/lib/format';
import type { KnowledgeContentKind, KnowledgeDocumentStatus } from '@/lib/knowledge/types';

interface KnowledgeDoc {
  id: string;
  filename: string;
  title: string;
  contentKind: KnowledgeContentKind;
  mimeType: string;
  byteSize: number;
  status: KnowledgeDocumentStatus;
  error: string | null;
  chunkCount: number;
  embeddedCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  processedAt: Date | string | null;
}

interface InspectionHit {
  chunkId: string;
  documentId: string;
  content: string;
  sourceFilename: string;
  sourceTitle: string;
  page: number | null;
  section: string | null;
  startOffset: number;
  endOffset: number;
  vectorScore: number | null;
  textScore: number | null;
  rankScore: number;
  reasons: string[];
}

const statusLabels: Record<KnowledgeDocumentStatus, string> = {
  pending: 'Pending',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
};

const kindLabels: Record<KnowledgeContentKind, string> = {
  pdf: 'PDF',
  markdown: 'Markdown',
  plain: 'Text',
  faq: 'FAQ',
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function asDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

export function KnowledgePanel({
  agentId,
  documents,
  storageReady,
}: {
  agentId: string;
  documents: KnowledgeDoc[];
  storageReady: boolean;
}) {
  const uploadInput = useRef<HTMLInputElement>(null);
  const replaceInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [inspection, setInspection] = useState<{
    query: string;
    hits: InspectionHit[];
  } | null>(null);

  function run(
    documentId: string | null,
    work: () => Promise<{
      error?: string;
      message?: string;
      inspection?: { query: string; hits: InspectionHit[] };
    }>,
  ) {
    setBusyId(documentId);
    startTransition(async () => {
      setError(null);
      setMessage(null);
      try {
        const result = await work();
        if (result.error) setError(result.error);
        if (result.message) setMessage(result.message);
        if (result.inspection) setInspection(result.inspection);
      } catch {
        setError('Unable to complete that knowledge action. Try again.');
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="knowledge-workbench">
      <section className="knowledge-library" aria-labelledby="knowledge-library-title">
        <div className="editor-section-heading knowledge-library-heading">
          <div>
            <h2 id="knowledge-library-title">Knowledge library</h2>
            <p className="muted">
              Upload PDF, Markdown, plain text or FAQ files. The worker extracts, chunks and embeds
              them for agent-scoped retrieval.
            </p>
          </div>
          <div className="knowledge-upload-actions">
            <Button
              type="button"
              variant="outline"
              disabled={pending || !storageReady}
              onClick={() => uploadInput.current?.click()}
            >
              {pending && busyId === null ? 'Uploading…' : 'Upload document'}
            </Button>
            <input
              ref={uploadInput}
              type="file"
              hidden
              accept=".pdf,.md,.markdown,.txt,.faq,application/pdf,text/markdown,text/plain,text/x-faq"
              disabled={pending || !storageReady}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (!file) return;
                const form = new FormData();
                form.set('agentId', agentId);
                form.set('file', file);
                run(null, () => uploadKnowledge(form));
              }}
            />
          </div>
        </div>

        {!storageReady && (
          <p className="field-hint">
            Document uploads need a RustFS connection. Ask your administrator to configure storage.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="field-hint" role="status">
            {message}
          </p>
        )}

        {!documents.length ? (
          <div className="knowledge-empty">
            <BookOpen size={30} strokeWidth={1.25} aria-hidden="true" />
            <h3>No documents yet</h3>
            <p>
              Add product docs, FAQs or brand guidance. Retrieved passages will cite the source
              document, page or section.
            </p>
          </div>
        ) : (
          <ul className="knowledge-list">
            {documents.map((doc) => {
              const created = asDate(doc.createdAt);
              const processed = asDate(doc.processedAt);
              const rowBusy = pending && busyId === doc.id;
              return (
                <li key={doc.id} className="knowledge-row">
                  <div className="knowledge-row-main">
                    <FileText size={18} aria-hidden="true" />
                    <div>
                      <div className="knowledge-row-title">
                        <span>{doc.title}</span>
                        <span className="state-label">{statusLabels[doc.status]}</span>
                      </div>
                      <p className="knowledge-row-meta">
                        {doc.filename} · {kindLabels[doc.contentKind]} · {formatBytes(doc.byteSize)}
                        {doc.chunkCount > 0
                          ? ` · ${doc.embeddedCount}/${doc.chunkCount} embedded`
                          : ''}
                        {created ? ` · ${formatUtcTimestamp(created)}` : ''}
                        {processed ? ` · ready ${formatUtcTimestamp(processed)}` : ''}
                      </p>
                      {doc.error && <p className="form-error">{doc.error}</p>}
                    </div>
                  </div>
                  <div className="knowledge-row-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        const form = new FormData();
                        form.set('agentId', agentId);
                        form.set('documentId', doc.id);
                        run(doc.id, () => reprocessKnowledge(form));
                      }}
                    >
                      {rowBusy ? 'Working…' : 'Reprocess'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending || !storageReady}
                      onClick={() => replaceInputs.current[doc.id]?.click()}
                    >
                      Replace
                    </Button>
                    <input
                      ref={(node) => {
                        replaceInputs.current[doc.id] = node;
                      }}
                      type="file"
                      hidden
                      accept=".pdf,.md,.markdown,.txt,.faq,application/pdf,text/markdown,text/plain,text/x-faq"
                      disabled={pending || !storageReady}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = '';
                        if (!file) return;
                        const form = new FormData();
                        form.set('agentId', agentId);
                        form.set('documentId', doc.id);
                        form.set('file', file);
                        run(doc.id, () => replaceKnowledge(form));
                      }}
                    />
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        const form = new FormData();
                        form.set('agentId', agentId);
                        form.set('documentId', doc.id);
                        run(doc.id, () => deleteKnowledge(form));
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

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
            const form = new FormData();
            form.set('agentId', agentId);
            form.set('query', query);
            run('inspect', () => inspectKnowledge(form));
          }}
        >
          <label htmlFor="knowledge-query">Query</label>
          <textarea
            id="knowledge-query"
            name="query"
            rows={4}
            maxLength={2000}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
            }}
            placeholder="Ask about a product detail, policy or FAQ…"
          />
          <div className="workspace-form-footer">
            <Button type="submit" disabled={pending || !query.trim()}>
              {pending && busyId === 'inspect' ? 'Searching…' : 'Inspect retrieval'}
            </Button>
          </div>
        </form>

        {!inspection ? (
          <div className="knowledge-inspector-empty">
            <Search size={24} aria-hidden="true" />
            <p>Enter a query to see ranked passages, vector/text scores and why they matched.</p>
          </div>
        ) : !inspection.hits.length ? (
          <div className="knowledge-inspector-empty">
            <Search size={24} aria-hidden="true" />
            <p>
              No passages matched “{inspection.query}”. Try different wording or wait for ready
              documents.
            </p>
          </div>
        ) : (
          <ul className="knowledge-hit-list">
            {inspection.hits.map((hit) => (
              <li key={hit.chunkId} className="knowledge-hit">
                <div className="knowledge-hit-header">
                  <strong>{hit.sourceTitle}</strong>
                  <span className="state-label">score {hit.rankScore.toFixed(3)}</span>
                </div>
                <p className="knowledge-row-meta">
                  {hit.sourceFilename}
                  {hit.page !== null ? ` · page ${hit.page}` : ''}
                  {hit.section ? ` · ${hit.section}` : ''}
                  {` · offsets ${hit.startOffset}–${hit.endOffset}`}
                  {hit.vectorScore !== null ? ` · vector ${hit.vectorScore.toFixed(3)}` : ''}
                  {hit.textScore !== null ? ` · text ${hit.textScore.toFixed(3)}` : ''}
                </p>
                <p className="knowledge-hit-why">{hit.reasons.join(' · ')}</p>
                <pre className="knowledge-hit-content">{hit.content}</pre>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
