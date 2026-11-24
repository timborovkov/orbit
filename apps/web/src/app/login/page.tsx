import Link from 'next/link';
import { redirect } from 'next/navigation';

import { LockKeyhole } from 'lucide-react';

import { login } from '@/actions/auth';
import { BrandMark } from '@/app/brand-mark';
import { PasswordField } from '@/app/login/password-field';
import { ThemeSwitch } from '@/app/theme';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (env().AUTH_DISABLED) redirect('/');
  const { error } = await searchParams;
  const invalid = Boolean(error);
  return (
    <div className="login-shell">
      <a className="skip-link" href="#login-main">
        Skip to sign in
      </a>
      <header className="login-header">
        <Link className="brand" href="/login" aria-label="Orbit home">
          <BrandMark size={34} />
          <span>Orbit</span>
        </Link>
        <ThemeSwitch />
      </header>
      <main id="login-main" className="login-main">
        <section className="login-card" aria-labelledby="login-title">
          <div className="login-heading">
            <BrandMark className="login-emblem" size={64} />
            <h1 id="login-title">Sign in to Orbit</h1>
            <p className="muted">Access your private workspace.</p>
          </div>
          <form action={login}>
            <FieldGroup className="gap-5">
              <Field data-invalid={invalid || undefined}>
                <FieldLabel htmlFor="email">
                  Email <span className="field-required">Required</span>
                </FieldLabel>
                <Input
                  id="email"
                  name="email"
                  aria-describedby={error ? 'login-error' : undefined}
                  aria-invalid={invalid || undefined}
                  type="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  className="m-0 min-h-11"
                />
              </Field>
              <PasswordField error={invalid} />
              {error && (
                <FieldError id="login-error" className="form-error m-0">
                  {error === 'limited'
                    ? 'Too many attempts. Try again in 15 minutes.'
                    : 'Unable to sign in. Check your credentials.'}
                </FieldError>
              )}
              <SubmitButton className="login-submit" pendingLabel="Signing in…">
                Sign in
              </SubmitButton>
            </FieldGroup>
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
