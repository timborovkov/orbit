import type { ReactNode } from 'react';

export default function IntroductionsLayout({ children }: { children: ReactNode }) {
  return (
    <main className="workspace-main people-workspace" id="main" tabIndex={-1}>
      {children}
    </main>
  );
}
