import { eq } from 'drizzle-orm';

import { controls } from '@/lib/schema';
import type { SeedModule } from '@/lib/seed/types';

/** Unpause the global kill-switch so the demo workspace looks operable. */
export const controlsModule: SeedModule = {
  name: 'controls',
  async apply({ tx }) {
    await tx.update(controls).set({ paused: false }).where(eq(controls.id, 1));
  },
};
