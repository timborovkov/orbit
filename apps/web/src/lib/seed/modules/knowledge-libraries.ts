import { knowledgeLibraries, knowledgeLibraryGrants } from '@/lib/schema';
import { DEMO_AGENTS, DEMO_KNOWLEDGE_LIBRARY_ID } from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

export const knowledgeLibrariesModule: SeedModule = {
  name: 'knowledge-libraries',
  async apply({ tx }) {
    const [library] = await tx
      .insert(knowledgeLibraries)
      .values({ id: DEMO_KNOWLEDGE_LIBRARY_ID, name: 'The Timeline handbook' })
      .onConflictDoNothing()
      .returning({ id: knowledgeLibraries.id });
    if (!library) return;
    await tx.insert(knowledgeLibraryGrants).values([
      { libraryId: library.id, agentId: DEMO_AGENTS.sarah },
      { libraryId: library.id, agentId: DEMO_AGENTS.john },
    ]);
  },
};
