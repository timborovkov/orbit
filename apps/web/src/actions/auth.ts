'use server';

import { redirect } from 'next/navigation';

import { signIn, signOut } from '@/lib/auth';

export async function login(form: FormData) {
  const result = await signIn(form);
  redirect(result === 'success' ? '/' : `/login?error=${result}`);
}
export async function logout() {
  redirect(await signOut());
}
