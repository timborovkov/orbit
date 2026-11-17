import { Check, ChevronDown, CircleAlert, MessageSquareText } from 'lucide-react';

import type { runs } from '@/lib/schema';

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
            {step.model} · {step.inputTokens} input / {step.outputTokens} output tokens · Cost not
            reported
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
              <span className="suppressed-label">
                <Check size={13} aria-hidden="true" /> Not sent
              </span>
            </div>
            <p>{action.reason}</p>
            {action.draft && <blockquote className="preserve-text">{action.draft}</blockquote>}
            <p className="muted">{action.effect}</p>
          </article>
        ))}
      </section>
      <details className="run-metadata">
        <summary>Run metadata</summary>
        <p>Run {run.id}</p>
        <p>{run.actor}</p>
        <p>{run.createdAt.toISOString()}</p>
      </details>
    </div>
  );
}
