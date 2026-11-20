'use client';

import { type RefObject } from 'react';

import { LoaderCircle, Upload } from 'lucide-react';

import { KnowledgeDocumentList, KnowledgeDropzone } from '@/app/knowledge-document-list';
import { KNOWLEDGE_ACCEPT, type KnowledgeDoc } from '@/app/knowledge-shared';
import { Button } from '@/components/ui/button';

export function KnowledgeDocumentsSection({
  agentId,
  documents,
  storageReady,
  pending,
  busyId,
  uploading,
  dragOver,
  error,
  uploadInput,
  onBrowse,
  onUploadFile,
  onReprocess,
  onReplace,
  onRequestDelete,
  setDragOver,
}: {
  agentId: string;
  documents: KnowledgeDoc[];
  storageReady: boolean;
  pending: boolean;
  busyId: string | null;
  uploading: boolean;
  dragOver: boolean;
  error: string | null;
  uploadInput: RefObject<HTMLInputElement | null>;
  onBrowse: () => void;
  onUploadFile: (file: File) => void;
  onReprocess: (documentId: string) => void;
  onReplace: (documentId: string, file: File) => void;
  onRequestDelete: (doc: KnowledgeDoc) => void;
  setDragOver: (value: boolean) => void;
}) {
  return (
    <section
      className="access-workbench knowledge-library"
      aria-labelledby="knowledge-library-title"
    >
      <div className="editor-section-heading knowledge-library-heading">
        <div>
          <h2 id="knowledge-library-title">Documents</h2>
          <p className="muted">
            Upload PDF, Markdown, plain text or FAQ files for agent-scoped retrieval.
          </p>
        </div>
        <div className="knowledge-upload-actions">
          <Button
            type="button"
            variant="outline"
            disabled={pending || !storageReady}
            onClick={onBrowse}
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
              if (file) onUploadFile(file);
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
          onBrowse={onBrowse}
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
            if (file) onUploadFile(file);
          }}
        />
      ) : (
        <KnowledgeDocumentList
          agentId={agentId}
          documents={documents}
          pending={pending}
          busyId={busyId}
          storageReady={storageReady}
          onReprocess={onReprocess}
          onReplace={onReplace}
          onRequestDelete={onRequestDelete}
        />
      )}
    </section>
  );
}
