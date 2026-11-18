import 'server-only';

import { asc } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { skills } from '@/lib/schema';

export async function listSkills() {
  const email = await requireAdmin();
  const items = await db().select().from(skills).orderBy(asc(skills.name));
  return { email, items };
}
