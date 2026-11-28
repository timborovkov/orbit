import type { ReactNode } from 'react';

function webUrl(href: string) {
  try {
    const url = new URL(href);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const url = webUrl(href);
  if (!url) return <>{children}</>;
  return (
    <a className={className} href={url} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
