import Link from 'next/link';

import { FlaskConical, GitCompareArrows } from 'lucide-react';

import { formatUtcTimestamp } from '@/lib/format';

export interface EvaluationCaseRow {
  id: string;
  agentId: string;
  title: string;
  sourceKind: 'playground' | 'email';
  input: string;
  createdAt: string;
  agentName: string;
}

export interface EvaluationComparisonRow {
  id: string;
  agentId: string;
  caseId: string;
  status: string;
  createdAt: string;
  caseTitle: string;
  agentName: string;
  error: string | null;
}

export function EvaluationLists({
  cases,
  comparisons,
}: {
  cases: EvaluationCaseRow[];
  comparisons: EvaluationComparisonRow[];
}) {
  return (
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
          <>
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
                        <div className="library-primary">{row.title}</div>
                        <div className="library-secondary preserve-text">{row.input}</div>
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
            <ul className="library-card-list">
              {cases.map((row) => (
                <li key={row.id} className="library-card">
                  <div className="library-card-copy">
                    <div className="library-primary">{row.title}</div>
                    <div className="library-secondary preserve-text">{row.input}</div>
                    <div className="library-meta">
                      {row.agentName} · {row.sourceKind === 'email' ? 'Email' : 'Playground'} ·{' '}
                      <time dateTime={row.createdAt}>
                        {formatUtcTimestamp(new Date(row.createdAt))}
                      </time>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
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
            <p>Start a comparison once you have a case and at least two configuration versions.</p>
          </div>
        )}
        {comparisons.length > 0 && (
          <>
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
                        <div className="library-primary">
                          <Link href={`/evaluations/${row.id}`}>{row.caseTitle}</Link>
                        </div>
                        {row.error && <div className="library-secondary">{row.error}</div>}
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
            <ul className="library-card-list">
              {comparisons.map((row) => (
                <li key={row.id} className="library-card">
                  <div className="library-card-copy">
                    <div className="library-primary">
                      <Link href={`/evaluations/${row.id}`}>{row.caseTitle}</Link>
                    </div>
                    {row.error && <div className="library-secondary">{row.error}</div>}
                    <div className="library-meta">
                      {row.agentName} · <span className="state-label">{row.status}</span> ·{' '}
                      <time dateTime={row.createdAt}>
                        {formatUtcTimestamp(new Date(row.createdAt))}
                      </time>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
