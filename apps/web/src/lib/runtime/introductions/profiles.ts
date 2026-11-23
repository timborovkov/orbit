import { sql } from 'drizzle-orm';

import type { Db, Tx } from '@/lib/db';
import type { IntroductionDisclosure } from '@/lib/runtime/introductions/types';

type ObservedProfile = Omit<IntroductionDisclosure, 'blurb'> & { personId: string };

// Filter each source by the acting agent before reading identity membership.
export async function observedProfiles(
  store: Db | Tx,
  agentId: string,
  options: { query?: string; personIds?: string[]; sourceIds?: string[] } = {},
) {
  const { personIds, sourceIds, query = '' } = options;
  const peopleFilter = personIds
    ? sql`AND identity.person_id IN (${sql.join(
        personIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
  const sourceFilter = sourceIds
    ? sql`AND source_id IN (${sql.join(
        sourceIds.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;

  return store.execute<ObservedProfile>(sql`
    WITH observations AS (
      SELECT id AS source_id, person_identity_id, received_at AS observed_at, 'email' AS source_kind,
        btrim(split_part(sender, '<', 1), ' "') AS display_name
      FROM email_messages
      WHERE agent_id = ${agentId} AND person_identity_id IS NOT NULL AND strpos(sender, '<') > 0
      UNION ALL
      SELECT id, person_identity_id, coalesce(provider_created_at, ingested_at), 'event',
        btrim(author_name)
      FROM source_events
      WHERE agent_id = ${agentId} AND person_identity_id IS NOT NULL
    ), profiles AS (
      SELECT DISTINCT ON (identity.person_id) identity.person_id, identity.id AS identity_id,
        identity.revision, source_kind, source_id, display_name, observed_at
      FROM observations
      JOIN person_identities identity ON identity.id = observations.person_identity_id
      WHERE char_length(display_name) BETWEEN 1 AND 100
        AND display_name ~ '[[:alpha:]]'
        AND display_name !~* '[@<>[:cntrl:]]|https?://|www[.]|([0-9][ .()+-]*){7}'
        ${peopleFilter} ${sourceFilter}
      ORDER BY identity.person_id, observed_at DESC, source_kind, source_id
    )
    SELECT person_id AS "personId", identity_id AS "identityId", revision AS "identityRevision",
      source_kind AS "sourceKind", source_id AS "sourceId", display_name AS name
    FROM profiles
    WHERE strpos(lower(display_name), lower(${query})) > 0
    ORDER BY observed_at DESC, person_id
    LIMIT 20
  `);
}
