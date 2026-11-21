'use client';

import { useRef, useState, useTransition } from 'react';

import { LoaderCircle, Upload } from 'lucide-react';

import {
  deleteKnowledge,
  replaceKnowledge,
  reprocessKnowledge,
  uploadKnowledge,
} from '@/actions/knowledge';
import { KnowledgeDocumentList, KnowledgeDropzone } from '@/app/knowledge-document-list';
import { KNOWLEDGE_ACCEPT, type KnowledgeDoc } from '@/app/knowledge-shared';
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
import type { KnowledgeScope } from '@/lib/knowledge/types';

export function KnowledgeDocumentsSection({
  scope,
  documents,
  storageReady,
  indexingReady = true,
}: {
  scope: KnowledgeScope;
  documents: KnowledgeDoc[];
  storageReady: boolean;
  indexingReady?: boolean;
}) {
  const uploadInput = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeDoc | null>(null);
  const uploading = pending && busyId === null;
  const uploadReady = storageReady && indexingReady;
  const shared = scope.kind === 'library';

  function mutate(
    action: (form: FormData) => Promise<{ error: string } | { message: string }>,
    documentId: string | null,
    file?: File,
  ) {
    if (pending) return;
    const form = new FormData();
    form.set(shared ? 'libraryId' : 'agentId', scope.id);
    if (documentId) form.set('documentId', documentId);
    if (file) form.set('file', file);
    setBusyId(documentId);
    setError(null);
    startTransition(async () => {
      try {
        const result = await action(form);
        if ('error' in result) setError(result.error);
      } catch {
        setError('Unable to complete that document action. Try again.');
      }
    });
  }

  function uploadFile(file: File) {
    if (uploadReady) mutate(uploadKnowledge, null, file);
  }

  function browse() {
    uploadInput.current?.click();
  }

  return (
    <section
      className="access-workbench knowledge-library"
      aria-labelledby="knowledge-library-title"
    >
      <div className="editor-section-heading knowledge-library-heading">
        <div>
          <h2 id="knowledge-library-title">Documents</h2>
          <p className="muted">
            {shared
              ? 'Upload PDF, Markdown, plain text or FAQ files for agents with access.'
              : 'Upload private PDF, Markdown, plain text or FAQ files for this agent.'}
          </p>
        </div>
        <div className="knowledge-upload-actions">
          <Button
            type="button"
            variant="outline"
            disabled={pending || !uploadReady}
            onClick={browse}
          >
            <Upload size={16} aria-hidden="true" />
            {uploading ? 'Uploading…' : 'Upload'}
          </Button>
          <input
            ref={uploadInput}
            type="file"
            hidden
            accept={KNOWLEDGE_ACCEPT}
            disabled={pending || !uploadReady}
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
      {!indexingReady && (
        <p className="field-hint">
          Shared knowledge indexing requires the workspace OpenRouter key.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {uploading && (
        <p className="knowledge-progress" role="status">
          <LoaderCircle size={14} className="knowledge-spin" aria-hidden="true" />
          Uploading document…
        </p>
      )}

      {!documents.length ? (
        <KnowledgeDropzone
          dragOver={dragOver}
          disabled={pending || !uploadReady}
          onBrowse={browse}
          onDragEnter={(event) => {
            event.preventDefault();
            if (uploadReady) setDragOver(true);
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
          documents={documents}
          pending={pending}
          busyId={busyId}
          storageReady={uploadReady}
          indexingReady={indexingReady}
          onReprocess={(id) => mutate(reprocessKnowledge, id)}
          onReplace={(id, file) => mutate(replaceKnowledge, id, file)}
          onRequestDelete={setDeleteTarget}
        />
      )}
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
              {shared
                ? 'This removes the file, chunks and embeddings for every agent with access.'
                : 'This removes the file, chunks and embeddings for this agent.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) mutate(deleteKnowledge, deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
