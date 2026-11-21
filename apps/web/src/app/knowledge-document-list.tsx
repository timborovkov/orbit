'use client';

import { useRef } from 'react';

import { BookOpen, FileText, LoaderCircle, MoreHorizontal, RefreshCw } from 'lucide-react';

import {
  asKnowledgeDate,
  formatKnowledgeBytes,
  KNOWLEDGE_ACCEPT,
  knowledgeChunkLabel,
  type KnowledgeDoc,
  knowledgeKindLabels,
  knowledgeStatusBadgeVariant,
  knowledgeStatusLabels,
} from '@/app/knowledge-shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatRelativeTime, formatUtcTimestamp } from '@/lib/format';
import { maxKnowledgeUploadLabel } from '@/lib/knowledge/types';
import { cn } from '@/lib/utils';

export function KnowledgeDropzone({
  dragOver,
  disabled,
  onBrowse,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
}: {
  dragOver: boolean;
  disabled: boolean;
  onBrowse: () => void;
  onDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={cn('knowledge-dropzone', dragOver && 'is-active')}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <BookOpen size={28} strokeWidth={1.25} aria-hidden="true" />
      <h3>No documents yet</h3>
      <p>Drop files or browse · up to {maxKnowledgeUploadLabel}.</p>
      <Button type="button" variant="outline" disabled={disabled} onClick={onBrowse}>
        Browse files
      </Button>
    </div>
  );
}

export function KnowledgeDocumentList({
  documents,
  pending,
  busyId,
  storageReady,
  indexingReady,
  onReprocess,
  onReplace,
  onRequestDelete,
}: {
  documents: KnowledgeDoc[];
  pending: boolean;
  busyId: string | null;
  storageReady: boolean;
  indexingReady: boolean;
  onReprocess: (documentId: string) => void;
  onReplace: (documentId: string, file: File) => void;
  onRequestDelete: (document: KnowledgeDoc) => void;
}) {
  const replaceInputs = useRef<Record<string, HTMLInputElement | null>>({});

  return (
    <ul className="knowledge-list">
      {documents.map((doc) => {
        const updated = asKnowledgeDate(doc.updatedAt);
        const rowBusy = pending && busyId === doc.id;
        const inFlight = doc.status === 'pending' || doc.status === 'processing';
        return (
          <li key={doc.id} className="knowledge-row">
            <div className="knowledge-row-main">
              <FileText size={18} aria-hidden="true" />
              <div className="knowledge-row-body">
                <div className="knowledge-row-title">
                  <span>{doc.title}</span>
                  <Badge
                    variant={knowledgeStatusBadgeVariant(doc.status)}
                    className={cn(
                      doc.status === 'ready' && 'knowledge-badge-ready',
                      inFlight && 'knowledge-badge-progress',
                    )}
                  >
                    {inFlight && (
                      <LoaderCircle size={12} className="knowledge-spin" aria-hidden="true" />
                    )}
                    {knowledgeStatusLabels[doc.status]}
                  </Badge>
                </div>
                <p className="knowledge-row-meta">
                  <span>{knowledgeKindLabels[doc.contentKind]}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatKnowledgeBytes(doc.byteSize)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{knowledgeChunkLabel(doc.chunkCount)}</span>
                  {updated && (
                    <>
                      <span aria-hidden="true">·</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="knowledge-row-time">
                            Updated {formatRelativeTime(updated)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{formatUtcTimestamp(updated)}</TooltipContent>
                      </Tooltip>
                    </>
                  )}
                </p>
                {doc.status === 'failed' && doc.error && (
                  <div className="knowledge-row-failed">
                    <p className="form-error">{doc.error}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending || !indexingReady}
                      onClick={() => {
                        onReprocess(doc.id);
                      }}
                    >
                      <RefreshCw size={14} aria-hidden="true" />
                      Retry
                    </Button>
                  </div>
                )}
                {inFlight && (
                  <p className="knowledge-progress" role="status">
                    <LoaderCircle size={14} className="knowledge-spin" aria-hidden="true" />
                    {doc.status === 'pending' ? 'Queued for processing…' : 'Processing…'}
                  </p>
                )}
              </div>
            </div>
            <div className="knowledge-row-actions">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={pending && busyId === doc.id}
                    aria-label={`Actions for ${doc.title}`}
                  >
                    {rowBusy ? (
                      <LoaderCircle size={16} className="knowledge-spin" aria-hidden="true" />
                    ) : (
                      <MoreHorizontal size={16} aria-hidden="true" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={pending || !indexingReady}
                    onSelect={() => {
                      onReprocess(doc.id);
                    }}
                  >
                    Reprocess
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={pending || !storageReady}
                    onSelect={() => replaceInputs.current[doc.id]?.click()}
                  >
                    Replace…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={pending}
                    onSelect={() => {
                      onRequestDelete(doc);
                    }}
                  >
                    Delete…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <input
                ref={(node) => {
                  replaceInputs.current[doc.id] = node;
                }}
                type="file"
                hidden
                accept={KNOWLEDGE_ACCEPT}
                disabled={pending || !storageReady}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (!file) return;
                  onReplace(doc.id, file);
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
