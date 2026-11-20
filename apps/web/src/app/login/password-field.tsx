'use client';

import { useState } from 'react';

import { Eye, EyeOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export function PasswordField({ error }: { error: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <Field data-invalid={error || undefined}>
      <FieldLabel htmlFor="password">
        Password <span className="field-required">Required</span>
      </FieldLabel>
      <div className="password-field m-0">
        <Input
          id="password"
          name="password"
          aria-describedby={error ? 'login-error' : undefined}
          aria-invalid={error || undefined}
          type={visible ? 'text' : 'password'}
          autoComplete="current-password"
          required
          maxLength={1024}
          className="m-0 min-h-11"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="password-visibility"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-controls="password"
          onClick={() => {
            setVisible(!visible);
          }}
        >
          {visible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
        </Button>
      </div>
    </Field>
  );
}
