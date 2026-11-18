import { encryptCredential } from '@/lib/runtime/secrets';
import { credentials } from '@/lib/schema';
import { demoAgents } from '@/lib/seed/catalog';
import type { SeedModule } from '@/lib/seed/types';

/**
 * Optional fake OpenRouter keys for agents that declare them.
 * Skipped when ORBIT_ENCRYPTION_KEY is unset so the Access tab still renders
 * the "not connected" state cleanly.
 */
export const credentialsModule: SeedModule = {
  name: 'credentials',
  async apply({ tx, encryptionKeyConfigured }) {
    if (!encryptionKeyConfigured) return;
    for (const agent of demoAgents()) {
      if (!agent.fakeOpenRouterKey) continue;
      const encryptedKey = encryptCredential(agent.id, agent.fakeOpenRouterKey);
      await tx.insert(credentials).values({ agentId: agent.id, encryptedKey }).onConflictDoUpdate({
        target: credentials.agentId,
        set: { encryptedKey },
      });
    }
  },
};
