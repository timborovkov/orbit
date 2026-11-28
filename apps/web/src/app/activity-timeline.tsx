import Link from 'next/link';

import { ExternalLink } from '@/components/external-link';
import { formatUtcTimestamp } from '@/lib/format';

export interface ActivityEventRow {
  id: string;
  summary: string;
  detail: string | null;
  createdAt: Date;
  dueAt: Date | null;
  channel: string | null;
  replyExcerpt: string | null;
  links: { label: string; href: string; external?: boolean }[];
}

export function ActivityTimeline({ events }: { events: ActivityEventRow[] }) {
  if (!events.length) return null;
  return (
    <section className="activity-timeline" aria-labelledby="activity-timeline-heading">
      <div className="editor-section-heading">
        <h2 id="activity-timeline-heading">Follow-ups & replies</h2>
        <p className="muted">Follow-up outcomes and outbound replies.</p>
      </div>
      <ol className="activity-timeline-list">
        {events.map((event) => (
          <li key={event.id} id={`activity-event-${event.id}`}>
            <span className="activity-summary">{event.summary}</span>
            {event.detail && <p className="muted activity-detail">{event.detail}</p>}
            {event.replyExcerpt && (
              <blockquote className="muted activity-detail">{event.replyExcerpt}</blockquote>
            )}
            <div className="activity-event-meta">
              <time dateTime={event.createdAt.toISOString()}>
                {formatUtcTimestamp(event.createdAt)}
              </time>
              {event.channel && <span>{event.channel}</span>}
              {event.channel && event.dueAt && (
                <span>
                  Due{' '}
                  <time dateTime={event.dueAt.toISOString()}>
                    {formatUtcTimestamp(event.dueAt)}
                  </time>
                </span>
              )}
            </div>
            {event.links.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {event.links.map((link) =>
                  link.external ? (
                    <ExternalLink className="person-source-link" key={link.label} href={link.href}>
                      {link.label}
                    </ExternalLink>
                  ) : (
                    <Link className="person-source-link" key={link.label} href={link.href}>
                      {link.label}
                    </Link>
                  ),
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
