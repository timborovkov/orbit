import { formatUtcTimestamp } from '@/lib/format';

export interface ActivityEventRow {
  id: string;
  kind: string;
  summary: string;
  detail: string | null;
  followUpId: string | null;
  createdAt: Date;
}

export function ActivityTimeline({ events }: { events: ActivityEventRow[] }) {
  return (
    <section className="activity-timeline" aria-labelledby="activity-timeline-heading">
      <div className="editor-section-heading">
        <h2 id="activity-timeline-heading">Activity</h2>
        <p className="muted">
          Internal outcomes for durable commitments and other agent events. External writes are not
          performed here.
        </p>
      </div>
      {!events.length && <p className="muted">No activity events yet.</p>}
      <ol className="activity-timeline-list">
        {events.map((event) => (
          <li
            key={event.id}
            id={event.followUpId ? `activity-follow-up-${event.followUpId}` : undefined}
          >
            <div className="activity-timeline-row">
              <div>
                <span className="activity-summary">{event.summary}</span>
                {event.detail && <p className="muted activity-detail">{event.detail}</p>}
                <time dateTime={event.createdAt.toISOString()}>
                  {formatUtcTimestamp(event.createdAt)} · {event.kind}
                </time>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
