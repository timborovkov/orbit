import { personRelationshipNotes } from '@/lib/schema';
import { DEMO_AGENTS, DEMO_EMAIL, DEMO_SOURCE_EVENTS } from '@/lib/seed/ids';
import type { SeedModule } from '@/lib/seed/types';

export const peopleModule: SeedModule = {
  name: 'people',
  async apply({ tx }) {
    await tx
      .insert(personRelationshipNotes)
      .values([
        {
          id: DEMO_EMAIL.messageId,
          agentId: DEMO_AGENTS.sarah,
          emailMessageId: DEMO_EMAIL.messageId,
          summary: 'The sender needs help finding their invoices.',
          excerpt: 'Where can I find my invoices?',
        },
        {
          id: DEMO_SOURCE_EVENTS.johnPost1001,
          agentId: DEMO_AGENTS.john,
          sourceEventId: DEMO_SOURCE_EVENTS.johnPost1001,
          summary: 'The author is looking for a work-history product.',
          excerpt: 'Looking for a work-history product',
        },
      ])
      .onConflictDoNothing();
  },
};
