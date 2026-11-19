'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FlaskConical, GitCompareArrows } from 'lucide-react';

import { startComparison } from '@/actions/evaluation';
import { SubmitButton } from '@/components/ui/submit-button';
import { formatUtcTimestamp } from '@/lib/format';

interface CaseRow {
  id: string;
  agentId: string;
  title: string;
  sourceKind: 'playground' | 'email';
  input: string;
  createdAt: string;
  agentName: string;
}

interface ComparisonRow {
  id: string;
  agentId: string;
  caseId: string;
  status: string;
  createdAt: string;
  caseTitle: string;
  agentName: string;
  error: string | null;
}

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
  cases: CaseRow[];
  comparisons: ComparisonRow[];
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

      <div className="evaluation-lists">
        <section aria-labelledby="cases-heading">
          <div className="editor-section-heading">
            <h2 id="cases-heading">Saved cases</h2>
            <p className="muted">Reusable inputs from Playground history or inbound email.</p>
          </div>
          {cases.length === 0 && (
            <div className="library-empty">
              <FlaskConical size={24} aria-hidden="true" />
              <h2>No cases yet</h2>
              <p>Save a completed playground run or inbound email from the agent workspace.</p>
            </div>
          )}
          {cases.length > 0 && (
            <div className="library-table-wrap">
              <table className="library-table">
                <thead>
                  <tr>
                    <th scope="col">Title</th>
                    <th scope="col">Agent</th>
                    <th scope="col">Source</th>
                    <th scope="col">Saved</th>
                  </tr>
                </thead>
                <tbody>
                  {cases.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <span className="library-primary">{row.title}</span>
                        <span className="library-secondary preserve-text">{row.input}</span>
                      </td>
                      <td>{row.agentName}</td>
                      <td>{row.sourceKind === 'email' ? 'Email' : 'Playground'}</td>
                      <td>
                        <time dateTime={row.createdAt}>
                          {formatUtcTimestamp(new Date(row.createdAt))}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section aria-labelledby="comparisons-heading">
          <div className="editor-section-heading">
            <h2 id="comparisons-heading">Comparisons</h2>
            <p className="muted">Open a past side-by-side replay to inspect drafts and policy.</p>
          </div>
          {comparisons.length === 0 && (
            <div className="library-empty">
              <GitCompareArrows size={24} aria-hidden="true" />
              <h2>No comparisons yet</h2>
              <p>
                Start a comparison once you have a case and at least two configuration versions.
              </p>
            </div>
          )}
          {comparisons.length > 0 && (
            <div className="library-table-wrap">
              <table className="library-table">
                <thead>
                  <tr>
                    <th scope="col">Case</th>
                    <th scope="col">Agent</th>
                    <th scope="col">Status</th>
                    <th scope="col">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {comparisons.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Link className="library-primary" href={`/evaluations/${row.id}`}>
                          {row.caseTitle}
                        </Link>
                        {row.error && <span className="library-secondary">{row.error}</span>}
                      </td>
                      <td>{row.agentName}</td>
                      <td>
                        <span className="state-label">{row.status}</span>
                      </td>
                      <td>
                        <time dateTime={row.createdAt}>
                          {formatUtcTimestamp(new Date(row.createdAt))}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
