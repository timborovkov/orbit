import { LockKeyhole } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { SubmitButton } from '../../components/ui/submit-button';
import { env } from '../../lib/env';
import { login } from '../actions';
import { ThemeSwitch } from '../theme';

import { PasswordField } from './password-field';
export const dynamic = 'force-dynamic';
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (env().AUTH_DISABLED) redirect('/');
  const { error } = await searchParams;
  return (
    <div className="login-shell">
      <a className="skip-link" href="#login-main">
        Skip to sign in
      </a>
      <header className="login-header">
        <Link className="brand" href="/login" aria-label="Orbit home">
          <Image src="/icon.svg" alt="" width="34" height="34" />
          <span>Orbit</span>
        </Link>
        <ThemeSwitch />
      </header>
      <main id="login-main" className="login-main">
        <section className="login-card" aria-labelledby="login-title">
          <div className="login-heading">
            <Image
              className="login-emblem"
              src="/icon.svg"
              alt=""
              width={64}
              height={64}
              priority
            />
            <h1 id="login-title">Sign in to Orbit</h1>
            <p className="muted">Access your private workspace.</p>
          </div>
          <form action={login}>
            <label htmlFor="email">
              Email <span className="field-required">Required</span>
            </label>
            <input
              id="email"
              name="email"
              aria-describedby={error ? 'login-error' : undefined}
              type="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
            <PasswordField error={Boolean(error)} />
            {error && (
              <p id="login-error" role="alert" className="form-error">
                {error === 'limited'
                  ? 'Too many attempts. Try again in 15 minutes.'
                  : 'Unable to sign in. Check your credentials.'}
              </p>
            )}
            <SubmitButton className="login-submit" pendingLabel="Signing in…">
              Sign in
            </SubmitButton>
          </form>
          <div className="login-note">
            <LockKeyhole size={12} />
            Administrator access only
          </div>
        </section>
      </main>
      <footer className="login-footer">Orbit · Private workspace</footer>
    </div>
  );
}
