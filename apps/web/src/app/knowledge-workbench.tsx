'use client';

import { type ReactNode, useEffect, useState, useTransition } from 'react';

import Link from 'next/link';

import { FileText, MessageSquare, Search } from 'lucide-react';

import { inspectKnowledge } from '@/actions/knowledge';
import { KnowledgeDocumentsSection } from '@/app/knowledge-documents-section';
import { KnowledgeInspectorPanel } from '@/app/knowledge-inspector-panel';
import { KnowledgePlaygroundAccess } from '@/app/knowledge-playground-access';
import type { InspectionHit, KnowledgeDoc, KnowledgeLibraryAccess } from '@/app/knowledge-shared';
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
  sharedLibraries,
  storageReady,
  searchEnabled,
}: {
  agentId: string;
  documents: KnowledgeDoc[];
  sharedLibraries: KnowledgeLibraryAccess[];
  storageReady: boolean;
  searchEnabled: boolean;
}) {
  const [active, setActive] = useState<(typeof sections)[number]['id']>('documents');
  const [compact, setCompact] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [inspection, setInspection] = useState<{
    library: string;
    query: string;
    hits: InspectionHit[];
    embeddingMode: 'openrouter' | 'stub';
  } | null>(null);
  const library = JSON.stringify([
    documents.map((doc) => [doc.id, doc.status, doc.updatedAt]),
    sharedLibraries,
  ]);

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

  function inspect() {
    const form = new FormData();
    form.set('agentId', agentId);
    form.set('query', query);
    setError(null);
    setInspection(null);
    startTransition(async () => {
      try {
        const result = await inspectKnowledge(form);
        if ('inspection' in result && result.inspection) {
          setInspection({ library, ...result.inspection });
        } else if (result.error) {
          setError(result.error);
        }
      } catch {
        setError('Unable to inspect knowledge. Try again.');
      }
    });
  }

  const panels: Record<(typeof sections)[number]['id'], ReactNode> = {
    documents: (
      <div className="knowledge-workspace-sections">
        <KnowledgeDocumentsSection
          scope={{ kind: 'agent', id: agentId }}
          documents={documents}
          storageReady={storageReady}
        />
        <section className="access-workbench" aria-labelledby="agent-shared-libraries-title">
          <div className="editor-section-heading">
            <h2 id="agent-shared-libraries-title">Shared libraries</h2>
            {!searchEnabled && sharedLibraries.length > 0 && (
              <p className="muted">Enable knowledge search in Playground to use these libraries.</p>
            )}
          </div>
          {sharedLibraries.length ? (
            <ul className="knowledge-list">
              {sharedLibraries.map((item) => (
                <li className="knowledge-row" key={item.id}>
                  <Link className="knowledge-source-link" href={`/knowledge/${item.id}`}>
                    {item.name}
                  </Link>
                  <span className="library-meta">
                    {item.readyCount} of {item.documentCount} ready
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No shared libraries assigned.</p>
          )}
        </section>
      </div>
    ),
    inspector: (
      <KnowledgeInspectorPanel
        agentId={agentId}
        query={query}
        pending={pending}
        error={error}
        inspection={inspection?.library === library ? inspection : null}
        onQueryChange={setQuery}
        onInspect={inspect}
      />
    ),
    playground: <KnowledgePlaygroundAccess agentId={agentId} searchEnabled={searchEnabled} />,
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
    </div>
  );
}
