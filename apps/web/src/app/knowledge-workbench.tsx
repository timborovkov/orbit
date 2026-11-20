'use client';

import { type ReactNode, useEffect, useRef, useState, useTransition } from 'react';

import { FileText, MessageSquare, Search } from 'lucide-react';

import {
  deleteKnowledge,
  inspectKnowledge,
  replaceKnowledge,
  reprocessKnowledge,
  saveKnowledgeSearchAccess,
  uploadKnowledge,
} from '@/actions/knowledge';
import { KnowledgeDocumentsSection } from '@/app/knowledge-documents-section';
import { KnowledgeInspectorPanel } from '@/app/knowledge-inspector-panel';
import { KnowledgePlaygroundAccess } from '@/app/knowledge-playground-access';
import type { InspectionHit, KnowledgeDoc } from '@/app/knowledge-shared';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { knowledgeSectionPanelHidden } from '@/lib/runtime/playground-ui';
import { cn } from '@/lib/utils';

const sections = [
  { id: 'documents', title: 'Documents', icon: FileText },
  { id: 'inspector', title: 'Inspector', icon: Search },
  { id: 'playground', title: 'Playground', icon: MessageSquare },
] as const;

export function KnowledgeWorkbench({
  agentId,
  documents,
  storageReady,
  searchEnabled,
}: {
  agentId: string;
  documents: KnowledgeDoc[];
  storageReady: boolean;
  searchEnabled: boolean;
}) {
  const uploadInput = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState<(typeof sections)[number]['id']>('documents');
  const [compact, setCompact] = useState(false);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeDoc | null>(null);
  const [query, setQuery] = useState('');
  const [inspection, setInspection] = useState<{
    library: string;
    query: string;
    hits: InspectionHit[];
    embeddingMode: 'openrouter' | 'stub';
  } | null>(null);
  const library = JSON.stringify(documents.map((doc) => [doc.id, doc.status, doc.updatedAt]));

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const sync = () => {
      setCompact(media.matches);
    };
    sync();
    media.addEventListener('change', sync);
    return () => {
      media.removeEventListener('change', sync);
    };
  }, []);

  useEffect(() => {
    if (compact) return;
    document
      .querySelector<HTMLButtonElement>(`.knowledge-sections button[aria-pressed='true']`)
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [active, compact]);

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
            library,
            query: result.inspection.query,
            hits: result.inspection.hits,
            embeddingMode: result.inspection.embeddingMode ?? 'openrouter',
          });
        } else if (!result.error && documentId !== 'access') {
          setInspection(null);
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

  const panels: Record<(typeof sections)[number]['id'], ReactNode> = {
    documents: (
      <KnowledgeDocumentsSection
        agentId={agentId}
        documents={documents}
        storageReady={storageReady}
        pending={pending}
        busyId={busyId}
        uploading={uploading}
        dragOver={dragOver}
        error={error}
        uploadInput={uploadInput}
        onBrowse={() => uploadInput.current?.click()}
        onUploadFile={uploadFile}
        setDragOver={setDragOver}
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
    ),
    inspector: (
      <KnowledgeInspectorPanel
        query={query}
        pending={pending}
        searching={pending && busyId === 'inspect'}
        error={error}
        inspection={inspection?.library === library ? inspection : null}
        onQueryChange={setQuery}
        onInspect={() => {
          const form = new FormData();
          form.set('agentId', agentId);
          form.set('query', query);
          run('inspect', () => inspectKnowledge(form));
        }}
      />
    ),
    playground: (
      <KnowledgePlaygroundAccess
        agentId={agentId}
        searchEnabled={searchEnabled}
        pending={pending && busyId === 'access'}
        onToggle={(enabled) => {
          const form = new FormData();
          form.set('agentId', agentId);
          form.set('enabled', String(enabled));
          run('access', () => saveKnowledgeSearchAccess(form));
        }}
      />
    ),
  };

  return (
    <div className="access-editor knowledge-editor">
      {compact ? (
        <div className="access-sections-compact">
          <label className="sr-only" htmlFor="knowledge-section-compact">
            Knowledge section
          </label>
          <Select
            value={active}
            onValueChange={(value) => {
              setActive(value as (typeof sections)[number]['id']);
            }}
          >
            <SelectTrigger
              id="knowledge-section-compact"
              className="w-full"
              aria-label="Knowledge section"
            >
              <SelectValue placeholder="Section" />
            </SelectTrigger>
            <SelectContent>
              {sections.map((section) => (
                <SelectItem key={section.id} value={section.id}>
                  {section.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="access-sections-shell">
          <nav className="access-sections knowledge-sections" aria-label="Knowledge sections">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                aria-pressed={active === section.id}
                className={cn(active === section.id && 'is-active')}
                onClick={() => {
                  setActive(section.id);
                }}
              >
                <section.icon size={16} aria-hidden="true" />
                {section.title}
              </button>
            ))}
          </nav>
        </div>
      )}
      <div className="access-fields-body">
        {sections.map((section) => (
          <div
            key={section.id}
            className="access-section-panel"
            hidden={knowledgeSectionPanelHidden(active, section.id)}
          >
            {panels[section.id]}
          </div>
        ))}
      </div>

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
