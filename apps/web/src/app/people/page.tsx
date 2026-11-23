import Link from 'next/link';

import { z } from 'zod';

import { WorkspaceHeader } from '@/app/workspace-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { env } from '@/lib/env';
import { listPeople, personHref } from '@/lib/server/people-queries';
import { getPendingApprovalCount } from '@/lib/server/workspace-queries';

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
    <ul className="people-list">
      {entries.map((person) => (
        <li key={person.id}>
          <Link
            href={
              linkSourceId ? `${personHref(person.id)}?link=${linkSourceId}` : personHref(person.id)
            }
          >
            <strong>{person.name}</strong>
            <span className="muted">{person.channels.join(' · ')}</span>
          </Link>
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
  const [directory, pendingApprovalCount] = await Promise.all([
    listPeople(query, page, linkIdentityId),
    getPendingApprovalCount(),
  ]);
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
    <div className="agent-shell">
      <WorkspaceHeader current="/people" pendingApprovalCount={pendingApprovalCount} />
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
            <Button variant="outline" asChild>
              <Link href="/people/introductions">Introductions</Link>
            </Button>
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
        {(page > 1 || directory.hasOlder) && (
          <nav aria-label="People pages" className="people-control-row">
            {page > 1 && (
              <Button variant="outline" asChild>
                <Link href={pageHref(page - 1)}>Previous page</Link>
              </Button>
            )}
            {directory.hasOlder && (
              <Button variant="outline" asChild>
                <Link href={pageHref(page + 1)}>Next page</Link>
              </Button>
            )}
          </nav>
        )}
      </main>
    </div>
  );
}
