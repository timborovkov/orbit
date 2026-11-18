import 'server-only';

import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/lib/db';
import { agents, agentSkills, audit, skills } from '@/lib/schema';

export const skillSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/, 'Use a lowercase slug (letters, numbers, _ or -).');

export const skillInput = z.object({
  name: skillSlug,
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(100_000),
});

export async function persistSkill(
  actor: string,
  input: z.infer<typeof skillInput>,
  skillId?: string,
) {
  return await db().transaction(async (tx) => {
    if (skillId) {
      const current = (
        await tx.select().from(skills).where(eq(skills.id, skillId)).for('update')
      ).at(0);
      if (!current) return { error: 'Skill not found.' as const };
      const contentChanged =
        current.description !== input.description ||
        current.body !== input.body ||
        current.title !== input.title ||
        current.name !== input.name;
      const version = contentChanged ? current.version + 1 : current.version;
      try {
        await tx
          .update(skills)
          .set({
            name: input.name,
            title: input.title,
            description: input.description,
            body: input.body,
            version,
            actor,
            updatedAt: new Date(),
          })
          .where(eq(skills.id, skillId));
      } catch {
        return { error: 'That skill name is already in use.' as const };
      }
      await tx.insert(audit).values({
        actor,
        action: `Updated skill ${input.name} to v${version}`,
      });
      return { id: skillId, version };
    }
    try {
      const row = (
        await tx
          .insert(skills)
          .values({
            name: input.name,
            title: input.title,
            description: input.description,
            body: input.body,
            actor,
          })
          .returning({ id: skills.id, version: skills.version })
      ).at(0);
      if (!row) throw new Error('insert failed');
      await tx.insert(audit).values({ actor, action: `Created skill ${input.name}` });
      return row;
    } catch {
      return { error: 'That skill name is already in use.' as const };
    }
  });
}

export async function deleteSkill(actor: string, skillId: string) {
  return await db().transaction(async (tx) => {
    const row = (
      await tx.delete(skills).where(eq(skills.id, skillId)).returning({ name: skills.name })
    ).at(0);
    if (!row) return false;
    await tx.insert(audit).values({ actor, action: `Deleted skill ${row.name}` });
    return true;
  });
}

export async function persistAgentSkills(actor: string, agentId: string, skillIds: string[]) {
  const unique = [...new Set(skillIds)];
  return await db().transaction(async (tx) => {
    // Serialize concurrent attachment replaces so two empty→insert saves cannot union.
    const agent = (
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update')
    ).at(0);
    if (!agent) return { error: 'Agent not found.' };
    if (unique.length) {
      const found = await tx
        .select({ id: skills.id })
        .from(skills)
        .where(inArray(skills.id, unique));
      if (found.length !== unique.length) return { error: 'One or more skills were not found.' };
    }
    await tx.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
    if (unique.length) {
      await tx.insert(agentSkills).values(unique.map((skillId) => ({ agentId, skillId })));
    }
    await tx.insert(audit).values({
      actor,
      action: `Updated skill attachments for agent ${agentId} (${unique.length} selected)`,
    });
    return { count: unique.length };
  });
}
