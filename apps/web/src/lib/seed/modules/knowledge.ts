import { knowledgeChunks, knowledgeDocuments } from '@/lib/schema';
import { demoKnowledgeDocuments } from '@/lib/seed/catalog';
import { demoTime } from '@/lib/seed/clock';
import type { SeedModule } from '@/lib/seed/types';

/** Ready / failed knowledge docs with chunks for Knowledge UI demos (no object bytes). */
export const knowledgeModule: SeedModule = {
  name: 'knowledge',
  async apply({ tx, now }) {
    for (const doc of demoKnowledgeDocuments()) {
      const createdAt = demoTime(now, doc.createdOffsetMs);
      const processedAt =
        doc.processedOffsetMs === null ? null : demoTime(now, doc.processedOffsetMs);
      const updatedAt = processedAt ?? createdAt;

      await tx
        .insert(knowledgeDocuments)
        .values({
          id: doc.id,
          agentId: doc.agentId,
          filename: doc.filename,
          title: doc.title,
          contentKind: doc.contentKind,
          mimeType: doc.mimeType,
          byteSize: doc.byteSize,
          objectKey: doc.objectKey,
          revision: doc.revision,
          processingToken: null,
          status: doc.status,
          error: doc.error,
          chunkCount: doc.chunks.length,
          embeddedCount: 0,
          contentHash: doc.contentHash,
          createdAt,
          updatedAt,
          processedAt,
        })
        .onConflictDoUpdate({
          target: knowledgeDocuments.id,
          set: {
            agentId: doc.agentId,
            filename: doc.filename,
            title: doc.title,
            contentKind: doc.contentKind,
            mimeType: doc.mimeType,
            byteSize: doc.byteSize,
            objectKey: doc.objectKey,
            revision: doc.revision,
            processingToken: null,
            status: doc.status,
            error: doc.error,
            chunkCount: doc.chunks.length,
            embeddedCount: 0,
            contentHash: doc.contentHash,
            createdAt,
            updatedAt,
            processedAt,
          },
        });

      for (const chunk of doc.chunks) {
        await tx
          .insert(knowledgeChunks)
          .values({
            id: chunk.id,
            documentId: doc.id,
            agentId: doc.agentId,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            contentHash: chunk.contentHash,
            sourceFilename: doc.filename,
            sourceTitle: doc.title,
            page: null,
            section: chunk.section,
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset,
            embedding: null,
            embeddingModel: null,
            embeddingDimensions: null,
            createdAt: processedAt ?? createdAt,
          })
          .onConflictDoUpdate({
            target: knowledgeChunks.id,
            set: {
              documentId: doc.id,
              agentId: doc.agentId,
              chunkIndex: chunk.chunkIndex,
              content: chunk.content,
              contentHash: chunk.contentHash,
              sourceFilename: doc.filename,
              sourceTitle: doc.title,
              page: null,
              section: chunk.section,
              startOffset: chunk.startOffset,
              endOffset: chunk.endOffset,
              embedding: null,
              embeddingModel: null,
              embeddingDimensions: null,
              createdAt: processedAt ?? createdAt,
            },
          });
      }
    }
  },
};
