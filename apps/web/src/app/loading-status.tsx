import { LoaderCircle } from 'lucide-react';

export function LoadingStatus({ children }: { children: string }) {
  return (
    <p role="status" className="muted inline-flex items-center gap-2 text-sm">
      <LoaderCircle className="shrink-0 motion-safe:animate-spin" size={16} aria-hidden="true" />
      {children}
    </p>
  );
}
