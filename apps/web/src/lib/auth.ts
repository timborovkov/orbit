import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { and, eq, gt } from 'drizzle-orm';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { db } from './db';
import { env } from './env';
import { sessions } from './schema';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function matches(a: string, b: string) {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
export async function checkOrigin() {
  const origin = (await headers()).get('origin');
  if (origin !== new URL(env().APP_URL).origin) throw new Error('Invalid request origin');
}
export async function requireAdmin() {
  const config = env();
  if (config.AUTH_DISABLED) {
    const host = (await headers()).get('host');
    if (host !== new URL(config.APP_URL).host)
      throw new Error('Local development request host does not match APP_URL');
    return config.AUTH_LOCAL_ADMIN_EMAIL;
  }
  const token = (await cookies()).get('orbit-session')?.value;
  if (!token) redirect('/login');
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
  const session = found.at(0);
  if (!session) redirect('/login');
  return session.email;
}
export async function createSession() {
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
