import Link from 'next/link';

import { UsersRoundIcon } from 'lucide-react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { env } from '@/lib/env';
import { formatRelativeTime, formatUtcTimestamp } from '@/lib/format';
import { personInitials } from '@/lib/people-display';
import { listPeople, personHref } from '@/lib/server/people-queries';

export const dynamic = 'force-dynamic';

function PeopleResults({
  entries,
  linkSourceId,
  query,
}: {
  entries: Awaited<ReturnType<typeof listPeople>>['people'];
  linkSourceId?: string;
  query: string;
}) {
  return entries.length ? (
    <ul className="people-list people-directory">
      {entries.map((person) => (
        <li key={person.id}>
          <span className="people-avatar" aria-hidden="true">
            {personInitials(person.name)}
          </span>
          <div className="people-row-body">
            <div className="people-row-title">
              <Link
                className="people-row-link"
                href={
                  linkSourceId
                    ? `${personHref(person.id)}?link=${linkSourceId}`
                    : personHref(person.id)
                }
              >
                {person.name}
              </Link>
              {person.handle && <span className="muted">{person.handle}</span>}
            </div>
            {person.relevance && <p className="people-relevance">{person.relevance}</p>}
            <dl className="people-meta">
              <div>
                <dt>Channels</dt>
                <dd>{person.channels.join(' · ') || '—'}</dd>
              </div>
              <div>
                <dt>Source agent</dt>
                <dd>
                  {person.sourceAgent ? (
                    <Link className="people-agent-link" href={`/agents/${person.sourceAgent.id}`}>
                      {person.sourceAgent.name}
                    </Link>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div>
                <dt>Last seen</dt>
                <dd>
                  {person.lastSeen ? (
                    <time dateTime={person.lastSeen} title={formatUtcTimestamp(person.lastSeen)}>
                      {formatRelativeTime(person.lastSeen)}
                    </time>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
            </dl>
          </div>
        </li>
      ))}
    </ul>
  ) : (
    <p className="muted">
      {query
        ? 'No people match your search.'
        : linkSourceId
          ? 'There are no other people to link.'
          : 'People appear here after agents receive channel activity.'}
    </p>
  );
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; link?: string }>;
}) {
  const search = await searchParams;
  const query = z.string().safeParse(search.q).data?.trim().slice(0, 160) ?? '';
  const page = z.coerce.number().int().min(1).max(100_000).safeParse(search.page).data ?? 1;
  const linkIdentityId = z.uuid().safeParse(search.link).data;
  const directory = await listPeople(query, page, linkIdentityId);
  const linkSource = directory.linkSource;
  function pageHref(number: number) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (linkSource) params.set('link', linkSource.id);
    if (number > 1) params.set('page', String(number));
    const suffix = params.toString();
    return suffix ? `/people?${suffix}` : '/people';
  }
  return (
    <main className="workspace-main people-workspace" id="main" tabIndex={-1}>
      {env().AUTH_DISABLED && (
        <p className="local-auth-notice" role="status">
          Authentication disabled · Local development
        </p>
      )}
      <div className="people-heading">
        <h1>{linkSource ? 'Choose a person to link' : 'People'}</h1>
        {linkSource ? (
          <Link href={personHref(linkSource.personId)}>Cancel linking</Link>
        ) : (
          <nav aria-label="People sections" className="people-tabs">
            <Button size="sm" asChild>
              <Link href="/people" aria-current="page">
                People
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/people/introductions">
                <UsersRoundIcon aria-hidden="true" />
                Introductions
              </Link>
            </Button>
          </nav>
        )}
      </div>
      <form action="/people" method="get" className="people-control-row" role="search">
        <label className="sr-only" htmlFor="people-search">
          Search people
        </label>
        <Input
          id="people-search"
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search names or identities"
          maxLength={160}
        />
        {linkSource && <input type="hidden" name="link" value={linkSource.id} />}
        <Button type="submit" variant="outline">
          Search
        </Button>
        {query && (
          <Link href={linkSource ? `/people?link=${linkSource.id}` : '/people'}>Clear</Link>
        )}
      </form>
      <PeopleResults entries={directory.people} linkSourceId={linkSource?.id} query={query} />
      {directory.people.length > 0 && (
        <nav aria-label="People pages" className="people-control-row people-pagination">
          {page > 1 && (
            <Button variant="outline" asChild>
              <Link href={pageHref(page - 1)}>Previous page</Link>
            </Button>
          )}
          <span className="muted">Page {page}</span>
          {directory.hasOlder && (
            <Button variant="outline" asChild>
              <Link href={pageHref(page + 1)}>Next page</Link>
            </Button>
          )}
        </nav>
      )}
    </main>
  );
}
