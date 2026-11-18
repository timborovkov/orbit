import { agentsModule } from '@/lib/seed/modules/agents';
import { approvalsModule } from '@/lib/seed/modules/approvals';
import { auditModule } from '@/lib/seed/modules/audit';
import { configurationsModule } from '@/lib/seed/modules/configurations';
import { consentsModule } from '@/lib/seed/modules/consents';
import { controlsModule } from '@/lib/seed/modules/controls';
import { credentialsModule } from '@/lib/seed/modules/credentials';
import { runsModule } from '@/lib/seed/modules/runs';
import { usageModule } from '@/lib/seed/modules/usage';
import type { SeedModule } from '@/lib/seed/types';

/**
 * Ordered seed modules. Add a new feature area by exporting a SeedModule and
 * appending it here — typically a few lines once the catalog rows exist.
 *
 * Upcoming features (skills/MCP, knowledge base, richer approvals) should each
 * ship a module rather than expanding unrelated ones.
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
  auditModule,
];

export function listSeedModuleNames(): string[] {
  return seedModules.map((module) => module.name);
}
