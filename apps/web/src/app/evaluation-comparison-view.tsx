import Link from 'next/link';

import { PendingRunRefresh } from '@/app/pending-run-refresh';
import { RunContent } from '@/app/run-content';
import { formatUtcTimestamp } from '@/lib/format';
import type { getEvaluationComparison } from '@/lib/server/evaluation-queries';

type Detail = NonNullable<Awaited<ReturnType<typeof getEvaluationComparison>>>;

function SideColumn({
  label,
  side,
  preferDraftAnswer,
}: {
  label: string;
  side: Detail['left'];
  preferDraftAnswer: boolean;
}) {
  return (
    <section className="evaluation-side" aria-label={label}>
      <header className="evaluation-side-heading">
        <h2>
          {label}
          {side.version !== null ? ` · v${side.version}` : ''}
        </h2>
        <p className="muted">{side.configName || 'Configuration snapshot'}</p>
        {side.run ? (
          <span className="state-label" role="status">
            {side.run.status}
          </span>
        ) : (
          <span className="state-label">Waiting</span>
        )}
      </header>
      {side.run ? (
        <RunContent
          run={side.run}
          interrupted={side.run.status === 'interrupted'}
          preferDraftAnswer={preferDraftAnswer}
        />
      ) : (
        <p className="muted">Replay has not produced a run for this side yet.</p>
      )}
    </section>
  );
}

export function EvaluationComparisonView({ detail }: { detail: Detail }) {
  const pending = detail.comparison.status === 'queued' || detail.comparison.status === 'running';
  const preferDraftAnswer = detail.comparison.caseSourceKind === 'email';
  return (
    <div className="evaluation-comparison">
      <PendingRunRefresh active={pending} />
      <nav className="agent-breadcrumb" aria-label="Breadcrumb">
        <Link href="/evaluations">Evaluations</Link>
      </nav>
      <div className="library-page-heading">
        <div>
          <h1>{detail.comparison.caseTitle}</h1>
          <p className="muted">
            {detail.comparison.agentName} · {detail.comparison.caseSourceKind} case ·{' '}
            <time dateTime={detail.comparison.createdAt.toISOString()}>
              {formatUtcTimestamp(detail.comparison.createdAt)}
            </time>
          </p>
        </div>
        <span className="state-label" role="status">
          {detail.comparison.status}
        </span>
      </div>
      <section className="evaluation-shared-input" aria-label="Shared case input">
        <h2>Shared input</h2>
        <p className="preserve-text">{detail.comparison.caseInput}</p>
        {detail.comparison.caseRecipients.length > 0 && (
          <p className="muted">Recipients: {detail.comparison.caseRecipients.join(', ')}</p>
        )}
      </section>
      {detail.comparison.error && (
        <p role="alert" className="form-error">
          {detail.comparison.error}
        </p>
      )}
      <div className="evaluation-side-by-side">
        <SideColumn
          label="Configuration A"
          side={detail.left}
          preferDraftAnswer={preferDraftAnswer}
        />
        <SideColumn
          label="Configuration B"
          side={detail.right}
          preferDraftAnswer={preferDraftAnswer}
        />
      </div>
    </div>
  );
}
