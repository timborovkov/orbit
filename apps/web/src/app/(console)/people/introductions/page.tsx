import Link from 'next/link';

import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { formatUtcTimestamp } from '@/lib/format';
import { listIntroductions } from '@/lib/server/introduction-queries';

export default async function IntroductionsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: value } = await searchParams;
  const page = z.coerce.number().int().min(1).max(100_000).safeParse(value).data ?? 1;
  const { rows, hasOlder } = await listIntroductions(page);
  return (
    <>
      <div className="people-heading">
        <h1>Introductions</h1>
        <Link href="/people">Back to People</Link>
      </div>
      {rows.length ? (
        <ul className="people-list">
          {rows.map((row) => (
            <li key={row.id}>
              <Link href={`/people/introductions/${row.id}`}>
                <strong>{row.names.join(' and ')}</strong>
                <span className="muted">
                  {row.agentName} · {formatUtcTimestamp(row.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Agents with the introduction grant can propose matches here.</p>
      )}
      {(page > 1 || hasOlder) && (
        <nav aria-label="Introduction pages" className="people-control-row">
          {page > 1 && (
            <Button variant="outline" asChild>
              <Link href={`/people/introductions?page=${page - 1}`}>Previous page</Link>
            </Button>
          )}
          {hasOlder && (
            <Button variant="outline" asChild>
              <Link href={`/people/introductions?page=${page + 1}`}>Next page</Link>
            </Button>
          )}
        </nav>
      )}
    </>
  );
}
