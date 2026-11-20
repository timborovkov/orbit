'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { startComparison } from '@/actions/evaluation';
import {
  EvaluationLists,
  type EvaluationCaseRow,
  type EvaluationComparisonRow,
} from '@/app/evaluation-lists';
import { SubmitButton } from '@/components/ui/submit-button';

interface VersionRow {
  id: string;
  agentId: string;
  version: number;
  name: string;
}

function firstAgentId(agents: { id: string }[], preferred?: string) {
  if (preferred && agents.some((agent) => agent.id === preferred)) return preferred;
  return agents[0]?.id ?? '';
}

function versionsFor(versions: VersionRow[], agentId: string) {
  return versions.filter((row) => row.agentId === agentId);
}

export function EvaluationsWorkbench({
  agentId,
  agents,
  cases,
  comparisons,
  versions,
}: {
  agentId?: string;
  agents: { id: string; name: string }[];
  cases: EvaluationCaseRow[];
  comparisons: EvaluationComparisonRow[];
  versions: VersionRow[];
}) {
  const router = useRouter();
  const [selectedAgent, setSelectedAgent] = useState(() => firstAgentId(agents, agentId));
  const [caseId, setCaseId] = useState(
    () => cases.find((row) => row.agentId === firstAgentId(agents, agentId))?.id ?? '',
  );
  const initialVersions = versionsFor(versions, firstAgentId(agents, agentId));
  const [leftId, setLeftId] = useState(
    () => initialVersions.at(1)?.id ?? initialVersions.at(0)?.id ?? '',
  );
  const [rightId, setRightId] = useState(() => initialVersions.at(0)?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const agentCases = cases.filter((row) => row.agentId === selectedAgent);
  const selectedCase = agentCases.find((row) => row.id === caseId) ?? agentCases.at(0);
  const currentVersions = versionsFor(versions, selectedAgent);

  return (
    <div className="evaluations-workbench">
      <div className="library-page-heading">
        <div>
          <h1>Evaluations</h1>
          <p className="muted">
            Save playground runs or inbound emails as cases, then replay the same input against two
            configuration versions. Replay never dispatches external writes.
          </p>
        </div>
      </div>

      <section className="evaluation-compare-panel" aria-labelledby="start-comparison-heading">
        <div className="editor-section-heading">
          <h2 id="start-comparison-heading">Compare two configurations</h2>
          <p className="muted">
            Pick a saved case and two versions. Results stay available to reopen.
          </p>
        </div>
        {agents.length === 0 && (
          <p className="muted">Create an agent before starting comparisons.</p>
        )}
        {agents.length > 0 && (
          <form
            className="evaluation-compare-form"
            action={(data) => {
              startTransition(async () => {
                setError(null);
                const result = await startComparison(data);
                if ('error' in result && result.error) {
                  setError(result.error);
                  return;
                }
                if ('comparisonId' in result) {
                  router.push(`/evaluations/${result.comparisonId}`);
                  router.refresh();
                }
              });
            }}
          >
            <label className="workspace-field">
              <span>Agent</span>
              <select
                className="library-field-control"
                name="agentId"
                value={selectedAgent}
                onChange={(event) => {
                  const next = event.target.value;
                  setSelectedAgent(next);
                  const nextCase = cases.find((row) => row.agentId === next);
                  setCaseId(nextCase?.id ?? '');
                  const nextVersions = versionsFor(versions, next);
                  setLeftId(nextVersions.at(1)?.id ?? nextVersions.at(0)?.id ?? '');
                  setRightId(nextVersions.at(0)?.id ?? '');
                }}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="workspace-field">
              <span>Case</span>
              <select
                className="library-field-control"
                name="caseId"
                value={selectedCase ? selectedCase.id : ''}
                onChange={(event) => {
                  setCaseId(event.target.value);
                }}
                required
              >
                {agentCases.length === 0 && <option value="">No saved cases</option>}
                {agentCases.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="workspace-field">
              <span>Configuration A</span>
              <select
                className="library-field-control"
                name="leftConfigurationId"
                value={leftId}
                onChange={(event) => {
                  setLeftId(event.target.value);
                }}
                required
              >
                {currentVersions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.version}
                    {version.name ? ` · ${version.name}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="workspace-field">
              <span>Configuration B</span>
              <select
                className="library-field-control"
                name="rightConfigurationId"
                value={rightId}
                onChange={(event) => {
                  setRightId(event.target.value);
                }}
                required
              >
                {currentVersions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.version}
                    {version.name ? ` · ${version.name}` : ''}
                  </option>
                ))}
              </select>
            </label>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <div className="workspace-form-footer">
              <SubmitButton
                disabled={pending || !selectedCase || currentVersions.length < 2}
                pendingLabel="Queuing…"
              >
                {pending ? 'Queuing…' : 'Start comparison'}
              </SubmitButton>
            </div>
          </form>
        )}
        {selectedCase && (
          <p className="evaluation-case-preview muted preserve-text">{selectedCase.input}</p>
        )}
      </section>

      <EvaluationLists cases={cases} comparisons={comparisons} />
    </div>
  );
}
