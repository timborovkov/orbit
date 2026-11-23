import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { FirecrawlError } from '@/lib/runtime/research/firecrawl';
import { resolveFirecrawlConfig } from '@/lib/runtime/research/settings';
import { firecrawlCredentials } from '@/lib/schema';

export async function loadFirecrawlConfig(agentId: string) {
  const [row] = await db()
    .select({ encryptedKey: firecrawlCredentials.encryptedKey })
    .from(firecrawlCredentials)
    .where(eq(firecrawlCredentials.agentId, agentId));
  try {
    return resolveFirecrawlConfig(agentId, row?.encryptedKey);
  } catch {
    throw new FirecrawlError(
      'unavailable',
      'Firecrawl credentials or deployment settings could not be loaded.',
    );
  }
}
