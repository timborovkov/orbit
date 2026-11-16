'use client';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useId, useSyncExternalStore } from 'react';

const modes = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'auto', label: 'Auto', Icon: Monitor },
] as const;
function subscribe(onChange: () => void) {
  window.addEventListener('orbit-theme-change', onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener('orbit-theme-change', onChange);
    window.removeEventListener('storage', onChange);
  };
}
function snapshot() {
  return document.documentElement.dataset.theme ?? 'auto';
}
export function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribe, snapshot, () => 'auto');
  const group = useId();
  return (
    <fieldset className="theme-switch">
      <legend className="sr-only">Appearance</legend>
      {modes.map(({ value, label, Icon }) => (
        <label
          key={value}
          className="theme-option"
          title={value === 'auto' ? 'Auto — follow device appearance' : `${label} appearance`}
        >
          <input
            type="radio"
            name={group}
            value={value}
            checked={theme === value}
            onChange={() => {
              document.documentElement.dataset.theme = value;
              try {
                localStorage.setItem('orbit-theme', value);
              } catch {
                /* Storage is optional. */
              }
              window.dispatchEvent(new Event('orbit-theme-change'));
            }}
          />
          <span className="theme-segment">
            <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="sr-only">{label}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
