import Link from 'next/link';

import { AgentAvatar } from '@/app/agent-avatar';
import { TermHint } from '@/components/term-hint';
import { lifecycleLabels, type LifecycleState } from '@/lib/lifecycle';

export function AgentWorkspaceHeader({
  id,
  name,
  pictureKey,
  role,
  lifecycle,
  version,
  keyLabel,
}: {
  id: string;
  name: string;
  pictureKey: string | null;
  role: string;
  lifecycle: LifecycleState;
  version: number;
  keyLabel: string;
}) {
  return (
    <>
      <nav className="agent-breadcrumb" aria-label="Breadcrumb">
        <ol>
          <li>
            <Link href="/#agents">Agents</Link>
          </li>
          <li aria-current="page">{name}</li>
        </ol>
      </nav>
      <div className="agent-title-row">
        <div className="agent-title-identity">
          <AgentAvatar id={id} name={name} pictureKey={pictureKey} className="agent-monogram" />
          <div>
            <div className="agent-name-line">
              <h1>{name}</h1>
              <span className="state-label">
                <span className="status-dot" />
                {lifecycleLabels[lifecycle]}
              </span>
            </div>
            <p className="muted">{role || 'Custom agent'}</p>
          </div>
        </div>
        <div className="agent-version">
          <TermHint hint={`Configuration v${version}`}>Version {version}</TermHint>
          <span className="muted">{keyLabel}</span>
        </div>
      </div>
    </>
  );
}
