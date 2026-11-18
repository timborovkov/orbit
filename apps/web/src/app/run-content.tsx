import {
  Ban,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  MessageSquareText,
  ShieldOff,
} from 'lucide-react';

import { formatUtcTimestamp } from '@/lib/format';
import type { runs } from '@/lib/schema';

function PolicyLabel({ policy }: { policy: string | undefined }) {
  if (policy === 'allow') {
    return (
      <span className="suppressed-label">
        <Check size={13} aria-hidden="true" /> Allowed
      </span>
    );
  }
  if (policy === 'needs-approval') {
    return (
      <span className="suppressed-label">
        <Clock3 size={13} aria-hidden="true" /> Needs approval
      </span>
    );
  }
  if (policy === 'deny' || policy === 'denied') {
    return (
      <span className="suppressed-label denied">
        <Ban size={13} aria-hidden="true" /> Denied
      </span>
    );
  }
  return (
    <span className="suppressed-label">
      <ShieldOff size={13} aria-hidden="true" /> Not sent
    </span>
  );
}

export function RunContent({
  run,
  interrupted = false,
}: {
  run: typeof runs.$inferSelect;
  interrupted?: boolean;
}) {
  return (
    <div className="run-content">
      <section className="run-input">
        <h3>Input</h3>
        <p className="preserve-text">{run.input}</p>
      </section>
      {interrupted && (
        <div className="run-notice">
          <CircleAlert size={18} aria-hidden="true" />
          <p>
            This run was interrupted. Its partial results are saved. Start a new simulation to
            retry.
          </p>
        </div>
      )}
      {run.result.error && (
        <div className="run-notice error">
          <CircleAlert size={18} aria-hidden="true" />
          <p>{run.result.error}</p>
        </div>
      )}
      {run.result.steps.map((step) => (
        <details key={step.stage} className="evaluation-detail">
          <summary>
            <span>{step.stage === 'evaluator' ? 'Evaluation' : 'Response planning'}</span>
            <span className="muted">
              {step.decision.relevant ? 'Relevant' : 'Not relevant'} ·{' '}
              {Math.round(step.decision.priority * 100)}% priority
            </span>
            <ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" />
          </summary>
          <p>{step.decision.reason}</p>
          <ul>
            {step.decision.actions.map((action) => (
              <li key={action.type}>
                {action.type}: {action.reason}
              </li>
            ))}
          </ul>
          <p className="run-usage">
            {step.model} · {step.inputTokens} input / {step.outputTokens} output tokens ·{' '}
            {step.costMicros === undefined
              ? 'Cost not reported'
              : `$${(step.costMicros / 1_000_000).toFixed(6)} USD`}
          </p>
        </details>
      ))}
      <section className="proposals">
        <div className="result-section-heading">
          <h3>Proposed actions</h3>
          <span className="muted">{run.result.actions.length} · Simulation only</span>
        </div>
        {!run.result.actions.length && <p className="muted">No actions proposed.</p>}
        {run.result.actions.map((action) => (
          <article key={action.type} className="action-proposal">
            <div className="result-section-heading">
              <h3>
                <MessageSquareText size={16} aria-hidden="true" />
                {action.type}
              </h3>
              <PolicyLabel policy={action.policy} />
            </div>
            <p>{action.reason}</p>
            {action.draft && <blockquote className="preserve-text">{action.draft}</blockquote>}
            <p className="muted">{action.effect}</p>
          </article>
        ))}
      </section>
      {((run.result.toolCalls?.length ?? 0) > 0 ||
        (run.result.skillVersions?.length ?? 0) > 0 ||
        (run.result.mcpConnections?.length ?? 0) > 0) && (
        <section className="proposals" aria-label="Skills and tools">
          <div className="result-section-heading">
            <h3>Skills and tools</h3>
          </div>
          {!!run.result.skillVersions?.length && (
            <ul className="resource-meta-list">
              {run.result.skillVersions.map((skill) => (
                <li key={skill.skillId}>
                  {skill.name} · v{skill.version}
                  {skill.loaded ? ' · loaded' : ' · catalogue only'}
                </li>
              ))}
            </ul>
          )}
          {!!run.result.mcpConnections?.length && (
            <ul className="resource-meta-list">
              {run.result.mcpConnections.map((connection) => (
                <li key={connection.connectionId}>
                  {connection.name}: {connection.status}
                  {connection.error ? ` · ${connection.error}` : ''}
                  {connection.tools.length
                    ? ` · ${connection.tools.length} tool${connection.tools.length === 1 ? '' : 's'}`
                    : ''}
                </li>
              ))}
            </ul>
          )}
          {!!run.result.toolCalls?.length && (
            <ul className="resource-meta-list">
              {run.result.toolCalls.map((call) => (
                <li
                  key={`${call.tool}:${JSON.stringify(call.args)}:${call.policy}:${call.error ?? ''}`}
                >
                  {call.tool} · {call.policy}
                  {call.error ? ` · ${call.error}` : ''}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <details className="run-metadata">
        <summary>Run metadata</summary>
        <p>Run {run.id}</p>
        <p>{run.actor}</p>
        <p>{formatUtcTimestamp(run.createdAt)}</p>
      </details>
    </div>
  );
}
