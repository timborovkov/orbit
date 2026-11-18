import 'server-only';

import { asc, count, eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { agentSkills, skills } from '@/lib/schema';

export async function listSkills() {
  const email = await requireAdmin();
  const rows = await db()
    .select({
      id: skills.id,
      name: skills.name,
      title: skills.title,
      description: skills.description,
      body: skills.body,
      version: skills.version,
      actor: skills.actor,
      createdAt: skills.createdAt,
      updatedAt: skills.updatedAt,
      agentCount: count(agentSkills.agentId),
    })
    .from(skills)
    .leftJoin(agentSkills, eq(agentSkills.skillId, skills.id))
    .groupBy(
      skills.id,
      skills.name,
      skills.title,
      skills.description,
      skills.body,
      skills.version,
      skills.actor,
      skills.createdAt,
      skills.updatedAt,
    )
    .orderBy(asc(skills.name));

  return {
    email,
    items: rows.map((row) => ({
      ...row,
      agentCount: row.agentCount,
    })),
  };
}
