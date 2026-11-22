import { agentsModule } from '@/lib/seed/modules/agents';
import { approvalsModule } from '@/lib/seed/modules/approvals';
import { auditModule } from '@/lib/seed/modules/audit';
import { configurationsModule } from '@/lib/seed/modules/configurations';
import { consentsModule } from '@/lib/seed/modules/consents';
import { controlsModule } from '@/lib/seed/modules/controls';
import { credentialsModule } from '@/lib/seed/modules/credentials';
import { discoveryModule } from '@/lib/seed/modules/discovery';
import { emailModule } from '@/lib/seed/modules/email';
import { evaluationsModule } from '@/lib/seed/modules/evaluations';
import { followUpsModule } from '@/lib/seed/modules/follow-ups';
import { knowledgeModule } from '@/lib/seed/modules/knowledge';
import { knowledgeLibrariesModule } from '@/lib/seed/modules/knowledge-libraries';
import { memoryModule } from '@/lib/seed/modules/memory';
import { peopleModule } from '@/lib/seed/modules/people';
import { runsModule } from '@/lib/seed/modules/runs';
import { usageModule } from '@/lib/seed/modules/usage';
import type { SeedModule } from '@/lib/seed/types';

/**
 * Ordered seed modules. Add a new feature area by exporting a SeedModule and
 * appending it here — typically a few lines once the catalog rows exist.
 */
export const seedModules: SeedModule[] = [
  controlsModule,
  agentsModule,
  configurationsModule,
  credentialsModule,
  usageModule,
  runsModule,
  consentsModule,
  approvalsModule,
  knowledgeModule,
  knowledgeLibrariesModule,
  emailModule,
  memoryModule,
  discoveryModule,
  peopleModule,
  followUpsModule,
  evaluationsModule,
  auditModule,
];

export function listSeedModuleNames(): string[] {
  return seedModules.map((module) => module.name);
}
