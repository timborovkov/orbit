import { ChevronDown } from 'lucide-react';

import { PlaygroundChat } from '@/app/playground-chat';
import { RunContent } from '@/app/run-content';
import type { LifecycleState } from '@/lib/lifecycle';
import type { getAgentWorkspace } from '@/lib/server/workspace-queries';

type WorkspaceHistory = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>['history'];
type WorkspaceVersions = NonNullable<Awaited<ReturnType<typeof getAgentWorkspace>>>['versions'];

export function PlaygroundPanel({
  agentId,
  agentName,
  canSimulate,
  lifecycle,
  versions,
  currentConfigurationId,
  history,
  latestRun,
  versionFor,
}: {
  agentId: string;
  agentName: string;
  canSimulate: boolean;
  lifecycle: LifecycleState;
  versions: WorkspaceVersions;
  currentConfigurationId: string;
  history: WorkspaceHistory;
  latestRun: WorkspaceHistory[number] | undefined;
  versionFor: (configurationId: string) => number | string;
}) {
  return (
    <section id="simulation" className="playground-panel">
      <PlaygroundChat
        key={agentId}
        agentId={agentId}
        agentName={agentName}
        canSimulate={canSimulate}
        lifecycle={lifecycle}
        versions={versions.map(({ id, version, config }) => ({ id, version, name: config.name }))}
        currentConfigurationId={currentConfigurationId}
        latestRun={
          latestRun && (
            <section className="playground-latest-run" aria-label="Latest persisted run">
              <h3>Latest persisted run</h3>
              <details key={latestRun.id} className="run-detail">
                <summary>
                  <div>
                    <span className="run-title">{latestRun.input}</span>
                    <span className="muted">Version {versionFor(latestRun.configurationId)}</span>
                  </div>
                  <span className="state-label" role="status">
                    {latestRun.displayStatus}
                  </span>
                  <ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" />
                </summary>
                <RunContent run={latestRun} interrupted={latestRun.interrupted} />
              </details>
            </section>
          )
        }
        runStatuses={Object.fromEntries(history.map(({ id, status }) => [id, status]))}
      />
    </section>
  );
}
