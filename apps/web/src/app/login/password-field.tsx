'use client';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../../components/ui/button';

export function PasswordField({ error }: { error: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <>
      <label htmlFor="password">
        Password <span className="field-required">Required</span>
      </label>
      <div className="password-field">
        <input
          id="password"
          name="password"
          aria-describedby={error ? 'login-error' : undefined}
          type={visible ? 'text' : 'password'}
          autoComplete="current-password"
          required
          maxLength={1024}
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
    </>
  );
}
