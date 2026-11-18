'use client';

import { useRef, useState, useTransition } from 'react';
import { LoaderCircle, Upload } from 'lucide-react';

import {
  deleteKnowledge,
  inspectKnowledge,
  replaceKnowledge,
  reprocessKnowledge,
  uploadKnowledge,
} from '@/actions/knowledge';
import { KnowledgeDocumentList, KnowledgeDropzone } from '@/app/knowledge-document-list';
import { KnowledgeInspectorPanel } from '@/app/knowledge-inspector-panel';
import { KNOWLEDGE_ACCEPT, type InspectionHit, type KnowledgeDoc } from '@/app/knowledge-shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

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
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeDoc | null>(null);
  const [query, setQuery] = useState('');
  const [inspection, setInspection] = useState<{
    query: string;
    hits: InspectionHit[];
    embeddingMode: 'openrouter' | 'stub';
  } | null>(null);

  function run(
    documentId: string | null,
    work: () => Promise<{
      error?: string;
      message?: string;
      documentId?: string;
      inspection?: {
        query: string;
        hits: InspectionHit[];
        embeddingMode?: 'openrouter' | 'stub';
      };
    }>,
  ) {
    setBusyId(documentId);
    startTransition(async () => {
      setError(null);
      try {
        const result = await work();
        if (result.error) setError(result.error);
        if (result.inspection) {
          setInspection({
            query: result.inspection.query,
            hits: result.inspection.hits,
            embeddingMode: result.inspection.embeddingMode ?? 'openrouter',
          });
        }
      } catch {
        setError('Unable to complete that knowledge action. Try again.');
      } finally {
        setBusyId(null);
        setUploading(false);
      }
    });
  }

  function uploadFile(file: File) {
    if (!storageReady) return;
    const form = new FormData();
    form.set('agentId', agentId);
    form.set('file', file);
    setUploading(true);
    run(null, () => uploadKnowledge(form));
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
              <Upload size={16} aria-hidden="true" />
              {uploading || (pending && busyId === null) ? 'Uploading…' : 'Upload'}
            </Button>
            <input
              ref={uploadInput}
              type="file"
              hidden
              accept={KNOWLEDGE_ACCEPT}
              disabled={pending || !storageReady}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) uploadFile(file);
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
        {(uploading || (pending && busyId === null)) && (
          <p className="knowledge-progress" role="status">
            <LoaderCircle size={14} className="knowledge-spin" aria-hidden="true" />
            Uploading document…
          </p>
        )}

        {!documents.length ? (
          <KnowledgeDropzone
            dragOver={dragOver}
            disabled={pending || !storageReady}
            onBrowse={() => uploadInput.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault();
              if (storageReady) setDragOver(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node)) return;
              setDragOver(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              const file = event.dataTransfer.files.item(0);
              if (file) uploadFile(file);
            }}
          />
        ) : (
          <KnowledgeDocumentList
            agentId={agentId}
            documents={documents}
            pending={pending}
            busyId={busyId}
            storageReady={storageReady}
            onReprocess={(documentId) => {
              const form = new FormData();
              form.set('agentId', agentId);
              form.set('documentId', documentId);
              run(documentId, () => reprocessKnowledge(form));
            }}
            onReplace={(documentId, file) => {
              const form = new FormData();
              form.set('agentId', agentId);
              form.set('documentId', documentId);
              form.set('file', file);
              run(documentId, () => replaceKnowledge(form));
            }}
            onRequestDelete={setDeleteTarget}
          />
        )}
      </section>

      <KnowledgeInspectorPanel
        query={query}
        pending={pending}
        searching={pending && busyId === 'inspect'}
        inspection={inspection}
        onQueryChange={setQuery}
        onInspect={() => {
          const form = new FormData();
          form.set('agentId', agentId);
          form.set('query', query);
          run('inspect', () => inspectKnowledge(form));
        }}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the file, chunks and embeddings for this agent. You can upload it again
              later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleteTarget) return;
                const form = new FormData();
                form.set('agentId', agentId);
                form.set('documentId', deleteTarget.id);
                run(deleteTarget.id, () => deleteKnowledge(form));
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
