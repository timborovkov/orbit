import { eq } from 'drizzle-orm';

import { controls } from '@/lib/schema';
import type { SeedModule } from '@/lib/seed/types';

/**
 * Global pause is a workspace-wide singleton shared by every agent.
 * Default seed leaves it untouched so refreshing demo fixtures cannot
 * silently release an administrator-selected pause that protects non-demo agents.
 * Pass --release-global-pause (or releaseGlobalPause: true) to opt in.
 */
export const controlsModule: SeedModule = {
  name: 'controls',
  async apply({ tx, releaseGlobalPause }) {
    if (!releaseGlobalPause) return;
    await tx.update(controls).set({ paused: false }).where(eq(controls.id, 1));
  },
};
