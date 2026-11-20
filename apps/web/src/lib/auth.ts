import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { and, eq, gt, sql } from 'drizzle-orm';

import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { audit, sessions } from '@/lib/schema';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function matches(a: string, b: string) {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
export async function checkOrigin() {
  const origin = (await headers()).get('origin');
  if (origin !== new URL(env().APP_URL).origin) throw new Error('Invalid request origin');
}

/** Resolve the admin session without redirecting — for Route Handlers and APIs. */
export async function getAdminEmail(): Promise<string | null> {
  const config = env();
  if (config.AUTH_DISABLED) {
    const host = (await headers()).get('host');
    if (host !== new URL(config.APP_URL).host) return null;
    return config.AUTH_LOCAL_ADMIN_EMAIL;
  }
  const token = (await cookies()).get('orbit-session')?.value;
  if (!token) return null;
  const found = await db()
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, hash(token)),
        gt(sessions.expiresAt, new Date()),
        eq(sessions.email, config.ORBIT_ADMIN_EMAIL),
        eq(sessions.credentialHash, hash(config.ORBIT_ADMIN_PASSWORD)),
      ),
    );
  return found.at(0)?.email ?? null;
}

export async function requireAdmin() {
  const email = await getAdminEmail();
  if (!email) redirect('/login');
  return email;
}
async function createSession() {
  const token = randomBytes(32).toString('hex');
  const config = env();
  if (config.AUTH_DISABLED) throw new Error('Sessions are unavailable with AUTH_DISABLED');
  await db().delete(sessions).where(eq(sessions.email, config.ORBIT_ADMIN_EMAIL));
  await db()
    .insert(sessions)
    .values({
      tokenHash: hash(token),
      email: config.ORBIT_ADMIN_EMAIL,
      credentialHash: hash(config.ORBIT_ADMIN_PASSWORD),
      expiresAt: new Date(Date.now() + 8 * 3600000),
    });
  (await cookies()).set('orbit-session', token, {
    httpOnly: true,
    secure: new URL(config.APP_URL).protocol === 'https:',
    sameSite: 'strict',
    path: '/',
    maxAge: 8 * 3600,
  });
}

export async function signIn(form: FormData) {
  await checkOrigin();
  const config = env();
  if (config.AUTH_DISABLED) {
    await requireAdmin();
    return 'success' as const;
  }
  // Global account limit is durable across processes; do not trust forwarded IP headers.
  const result = await db().execute(
    sql`
      INSERT INTO login_attempts (identity, attempts, window_start)
      VALUES ('admin', 1, now())
      ON CONFLICT (identity) DO UPDATE SET
        attempts = CASE
          WHEN login_attempts.window_start < now() - interval '15 minutes' THEN 1
          ELSE login_attempts.attempts + 1
        END,
        window_start = CASE
          WHEN login_attempts.window_start < now() - interval '15 minutes' THEN now()
          ELSE login_attempts.window_start
        END
      RETURNING attempts
    `,
  );
  if (Number(result.at(0)?.attempts) > 10) return 'limited' as const;
  const email = form.get('email');
  const password = form.get('password');
  if (
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    !matches(email, config.ORBIT_ADMIN_EMAIL) ||
    !matches(password, config.ORBIT_ADMIN_PASSWORD)
  )
    return 'invalid' as const;
  await createSession();
  await db().insert(audit).values({
    actor: config.ORBIT_ADMIN_EMAIL,
    action: 'Administrator signed in',
  });
  return 'success' as const;
}
export async function signOut() {
  await checkOrigin();
  const actor = await requireAdmin();
  if (env().AUTH_DISABLED) return '/' as const;
  const token = (await cookies()).get('orbit-session')?.value;
  if (token)
    await db()
      .delete(sessions)
      .where(and(eq(sessions.tokenHash, hash(token)), eq(sessions.email, actor)));
  (await cookies()).delete('orbit-session');
  return '/login' as const;
}
