import 'server-only';

import { asc } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { mcpConnections } from '@/lib/schema';

export async function listMcpConnections() {
  const email = await requireAdmin();
  const rows = await db().select().from(mcpConnections).orderBy(asc(mcpConnections.name));
  return {
    email,
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      transport: row.transport,
      toolAllowlist: row.toolAllowlist,
      hasHeaders: Boolean(row.encryptedHeaders),
      updatedAt: row.updatedAt,
      actor: row.actor,
    })),
  };
}
