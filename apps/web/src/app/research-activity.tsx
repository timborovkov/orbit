import { ResearchActivityAction } from '@/app/research-activity-actions';
import { type CrawlStatus, WEB_SEARCH } from '@/lib/research';
import type { getWebResearchActivity } from '@/lib/server/research-queries';

export type WebResearchActivity = Awaited<ReturnType<typeof getWebResearchActivity>>;

const labels: Record<CrawlStatus, string> = {
  queued: 'Queued',
  submitting: 'Submitting',
  running: 'Running',
  cancelling: 'Cancelling',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  unavailable: 'Unavailable',
};

function Citations({
  agentId,
  citations,
  libraries,
}: {
  agentId: string;
  citations: WebResearchActivity['citations'];
  libraries: WebResearchActivity['libraries'];
}) {
  if (!citations.length) return null;
  return (
    <ol className="research-sources">
      {citations.map((citation) => (
        <li key={citation.id} id={'web-source-' + citation.id}>
          <a href={citation.url} target="_blank" rel="noopener noreferrer">
            {citation.title}
          </a>
          <p className="muted">{citation.url}</p>
          {citation.tool === WEB_SEARCH && <p className="muted">Search rank {citation.rank}</p>}
          {citation.excerpt && <blockquote>{citation.excerpt}</blockquote>}
          {citation.importable && libraries.length > 0 && (
            <details>
              <summary>Import page</summary>
              <ResearchActivityAction
                agentId={agentId}
                target={{ citationId: citation.id, libraries }}
              />
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}

export function ResearchActivity({
  agentId,
  crawls,
  citations,
  libraries,
}: WebResearchActivity & { agentId: string }) {
  if (!crawls.length && !citations.length) return null;
  return (
    <section className="research-activity" aria-label="Web research">
      <h3>Web research</h3>
      <Citations
        agentId={agentId}
        libraries={libraries}
        citations={citations.filter((citation) => !citation.crawlId)}
      />
      {crawls.map((crawl) => (
        <section
          className="research-crawl"
          key={crawl.id}
          id={'crawl-' + crawl.id}
          aria-label={'Crawl ' + crawl.seedUrl}
        >
          <p className="research-seed">
            <strong>Crawl</strong> {crawl.seedUrl}
          </p>
          <p className="muted">
            {labels[crawl.status]} · {crawl.completedPages}
            {crawl.discoveredPages > crawl.completedPages
              ? ' of ' + crawl.discoveredPages
              : ''}{' '}
            pages read · page limit {crawl.pageLimit} · depth limit {crawl.depthLimit}
            {crawl.creditsUsed !== null && ' · ' + crawl.creditsUsed + ' provider credits'}
          </p>
          {crawl.reason && <p>{crawl.reason}</p>}
          {['queued', 'submitting', 'running'].includes(crawl.status) && (
            <ResearchActivityAction agentId={agentId} target={{ crawlId: crawl.id }} />
          )}
          <Citations
            agentId={agentId}
            libraries={libraries}
            citations={citations.filter((citation) => citation.crawlId === crawl.id)}
          />
        </section>
      ))}
    </section>
  );
}
