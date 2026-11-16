'use server';
import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { requireAdmin, checkOrigin, createSession, hash, matches } from '../lib/auth';
import { db } from '../lib/db';
import { env } from '../lib/env';
import { agents, audit, controls, sessions } from '../lib/schema';
export async function login(form: FormData) {
  await checkOrigin();
  const config = env();
  if (config.AUTH_DISABLED) {
    await requireAdmin();
    redirect('/');
  }
  // Global account limit is durable across processes; do not trust forwarded IP headers.
  const result = await db().execute(
    sql`INSERT INTO login_attempts VALUES ('admin',1,now()) ON CONFLICT(identity) DO UPDATE SET attempts=CASE WHEN login_attempts.window_start < now()-interval '15 minutes' THEN 1 ELSE login_attempts.attempts+1 END, window_start=CASE WHEN login_attempts.window_start < now()-interval '15 minutes' THEN now() ELSE login_attempts.window_start END RETURNING attempts`,
  );
  if (Number(result.at(0)?.attempts) > 10) redirect('/login?error=limited');
  const email = form.get('email');
  const password = form.get('password');
  if (
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    !matches(email, config.ORBIT_ADMIN_EMAIL) ||
    !matches(password, config.ORBIT_ADMIN_PASSWORD)
  )
    redirect('/login?error=invalid');
  await createSession();
  await db().insert(audit).values({
    actor: config.ORBIT_ADMIN_EMAIL,
    action: 'Administrator signed in',
  });
  redirect('/');
}
export async function logout() {
  await checkOrigin();
  const actor = await requireAdmin();
  if (env().AUTH_DISABLED) redirect('/');
  const token = (await cookies()).get('orbit-session')?.value;
  if (token)
    await db()
      .delete(sessions)
      .where(and(eq(sessions.tokenHash, hash(token)), eq(sessions.email, actor)));
  (await cookies()).delete('orbit-session');
  redirect('/login');
}
export async function createAgent(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(80),
      mission: z.string().trim().min(1).max(2000),
    })
    .safeParse({ name: form.get('name'), mission: form.get('mission') });
  if (!parsed.success)
    return { ok: false as const, errors: z.flattenError(parsed.error).fieldErrors };
  const data = parsed.data;
  await db().transaction(async (tx) => {
    await tx.insert(agents).values(data);
    await tx.insert(audit).values({ actor, action: `Created paused agent: ${data.name}` });
  });
  revalidatePath('/');
  return { ok: true as const };
}
export async function setGlobalPause(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const paused = z.enum(['true', 'false']).parse(form.get('paused')) === 'true';
  await db().transaction(async (tx) => {
    const states = await tx.update(controls).set({ paused }).where(eq(controls.id, 1)).returning();
    const state = states.at(0);
    if (!state) throw new Error('Outbound control is missing');
    await tx.insert(audit).values({
      actor,
      action: state.paused ? 'Global outbound pause enabled' : 'Global outbound pause released',
    });
  });
  revalidatePath('/');
}
