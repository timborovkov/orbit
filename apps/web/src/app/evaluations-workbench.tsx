'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { startComparison } from '@/actions/evaluation';
import {
  EvaluationLists,
  type EvaluationCaseRow,
  type EvaluationComparisonRow,
} from '@/app/evaluation-lists';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  const formId = useId();
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
            <FieldGroup className="evaluation-compare-fields">
              <Field>
                <FieldLabel htmlFor={`${formId}-agent`}>Agent</FieldLabel>
                <input type="hidden" name="agentId" value={selectedAgent} />
                <Select
                  value={selectedAgent}
                  onValueChange={(next) => {
                    setSelectedAgent(next);
                    const nextCase = cases.find((row) => row.agentId === next);
                    setCaseId(nextCase?.id ?? '');
                    const nextVersions = versionsFor(versions, next);
                    setLeftId(nextVersions.at(1)?.id ?? nextVersions.at(0)?.id ?? '');
                    setRightId(nextVersions.at(0)?.id ?? '');
                  }}
                >
                  <SelectTrigger id={`${formId}-agent`} className="w-full" aria-label="Agent">
                    <SelectValue placeholder="Choose an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-case`}>Case</FieldLabel>
                <input type="hidden" name="caseId" value={selectedCase ? selectedCase.id : ''} />
                <Select
                  value={selectedCase ? selectedCase.id : undefined}
                  onValueChange={setCaseId}
                >
                  <SelectTrigger id={`${formId}-case`} className="w-full" aria-label="Case">
                    <SelectValue placeholder="No saved cases" />
                  </SelectTrigger>
                  <SelectContent>
                    {agentCases.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-left`}>Configuration A</FieldLabel>
                <input type="hidden" name="leftConfigurationId" value={leftId} />
                <Select value={leftId || undefined} onValueChange={setLeftId}>
                  <SelectTrigger
                    id={`${formId}-left`}
                    className="w-full"
                    aria-label="Configuration A"
                  >
                    <SelectValue placeholder="Choose a version" />
                  </SelectTrigger>
                  <SelectContent>
                    {currentVersions.map((version) => (
                      <SelectItem key={version.id} value={version.id}>
                        v{version.version}
                        {version.name ? ` · ${version.name}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-right`}>Configuration B</FieldLabel>
                <input type="hidden" name="rightConfigurationId" value={rightId} />
                <Select value={rightId || undefined} onValueChange={setRightId}>
                  <SelectTrigger
                    id={`${formId}-right`}
                    className="w-full"
                    aria-label="Configuration B"
                  >
                    <SelectValue placeholder="Choose a version" />
                  </SelectTrigger>
                  <SelectContent>
                    {currentVersions.map((version) => (
                      <SelectItem key={version.id} value={version.id}>
                        v{version.version}
                        {version.name ? ` · ${version.name}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
            {error && <FieldError>{error}</FieldError>}
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
