import 'server-only';

import { asc, desc, eq, inArray, or, sql } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { relevanceSnippet } from '@/lib/people-display';
import { channelLabel } from '@/lib/runtime/channels/registry';
import { getPersonContextForAgent, listPersonInteractions } from '@/lib/runtime/people/history';
import {
  agents,
  emailMessages,
  people,
  type PersonChannel,
  personContacts,
  personIdentities,
  personIdentityChanges,
  sourceEvents,
} from '@/lib/schema';
import { selectPersonMemories } from '@/lib/server/memory-queries';

const peoplePerPage = 40;
const displayNameSql = sql`
  coalesce(nullif(btrim(post.author_name), ''), nullif('@' || post.author_username, '@'),
    nullif(btrim(split_part(mail.sender, '<', 1), ' "'), ''), identity.identity_key)
`;
const latestPeopleSources = sql`
  left join lateral (
    select id, agent_id, sender, thread_id from email_messages
    where person_identity_id = identity.id
    order by received_at desc, id desc limit 1
  ) mail on identity.channel = 'email'
  left join lateral (
    select id, agent_id, author_name, author_username, run_id, provider_event_id
    from source_events where person_identity_id = identity.id and provider = identity.channel
    order by coalesce(provider_created_at, ingested_at) desc, id desc limit 1
  ) post on true
`;

function personActivity(condition: ReturnType<typeof sql>) {
  return sql`
    select entry.agent_id, entry.occurred_at, entry.excerpt from (
      select mail_entry.agent_id, mail_entry.received_at as occurred_at, mail_entry.id,
        mail_entry.subject as excerpt
      from person_identities activity_identity
      join email_messages mail_entry on mail_entry.person_identity_id = activity_identity.id
      where activity_identity.person_id = person.id
      union all
      select post_entry.agent_id, coalesce(post_entry.provider_created_at, post_entry.ingested_at),
        post_entry.id, left(post_entry.text, 400)
      from person_identities activity_identity
      join source_events post_entry on post_entry.person_identity_id = activity_identity.id
        and post_entry.provider = activity_identity.channel
      where activity_identity.person_id = person.id
    ) entry
    where ${condition} order by entry.occurred_at desc, entry.id desc limit 1
  `;
}

export function personHref(personId: string) {
  return `/people/${personId}`;
}

export async function listPeople(query: string, page: number, linkIdentityId?: string) {
  await requireAdmin();
  const store = db();
  const [linkSource] = linkIdentityId
    ? await store
        .select({ id: personIdentities.id, personId: personIdentities.personId })
        .from(personIdentities)
        .where(eq(personIdentities.id, linkIdentityId))
    : [];
  const omitSource = linkSource ? sql`and person.id <> ${linkSource.personId}` : sql``;
  const match = query
    ? sql`
    and (exists (
      select 1 from person_identities identity ${latestPeopleSources}
      where identity.person_id = person.id and position(lower(${query}) in lower(concat_ws(
        ' ', identity.identity_key, mail.sender, post.author_name, post.author_username, '@' || post.author_username
      ))) > 0
    ) or exists (
      select 1 from person_contacts contact where contact.person_id = person.id
        and position(lower(${query}) in lower(contact.label)) > 0
    ))
  `
    : sql``;
  const rows = await store.execute<{
    id: string;
    name: string;
    handle: string | null;
    sourceAgentId: string | null;
    sourceAgentName: string | null;
    relevance: string | null;
    lastSeen: string | null;
    channels: string[];
  }>(sql`
    select person.id, coalesce(primary_identity.label, primary_contact.label) as name,
      primary_identity.handle, source_agent.id as "sourceAgentId", source_agent.name as "sourceAgentName",
      latest_activity.excerpt as relevance,
      to_char(latest_activity.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "lastSeen",
      array(select distinct channel from person_identities where person_id = person.id order by channel) as channels
    from people person
    left join lateral (
      select ${displayNameSql} as label,
        case when post.author_username is not null then '@' || post.author_username
          when identity.channel = 'email' then identity.identity_key end as handle
      from person_identities identity ${latestPeopleSources}
      where identity.person_id = person.id order by (identity.home_person_id = identity.person_id) desc, identity.channel, identity.id limit 1
    ) primary_identity on true
    left join lateral (
      select contact.label from person_contacts contact where contact.person_id = person.id
      order by contact.kind, contact.id limit 1
    ) primary_contact on true
    left join lateral (${personActivity(sql`true`)}) latest_activity on true
    left join agents source_agent on source_agent.id = latest_activity.agent_id
    where (primary_identity.label is not null or primary_contact.label is not null) ${omitSource} ${match}
    order by person.created_at desc, person.id desc limit ${peoplePerPage + 1} offset ${(page - 1) * peoplePerPage}
  `);
  return {
    people: rows.slice(0, peoplePerPage).map((row) => ({
      id: row.id,
      name: row.name,
      handle: row.handle && row.handle !== row.name ? row.handle : null,
      sourceAgent: row.sourceAgentId
        ? { id: row.sourceAgentId, name: row.sourceAgentName ?? 'Agent' }
        : null,
      relevance: relevanceSnippet(row.relevance),
      lastSeen: row.lastSeen,
      channels: row.channels.map(channelLabel),
    })),
    hasOlder: rows.length > peoplePerPage,
    linkSource,
  };
}

type IdentitySummary = {
  id: string;
  personId: string;
  channel: PersonChannel;
  identityKey: string;
  displayName: string;
  handle: string | null;
  linkState: 'standalone' | 'inferred' | 'confirmed';
  linkedViaId: string | null;
  revision: number;
  sourceId: string | null;
  agentId: string | null;
  threadId: string | null;
  runId: string | null;
  postId: string | null;
  claimEvidence: {
    claim: string;
    sourceId: string;
    agentId: string;
    threadId: string | null;
    runId: string | null;
    postId: string | null;
  } | null;
};

function loadIdentities(condition: ReturnType<typeof sql>) {
  return db().execute<IdentitySummary>(sql`
    select identity.id, identity.person_id as "personId", identity.channel,
      identity.identity_key as "identityKey", identity.link_state as "linkState",
      identity.linked_via_id as "linkedViaId", identity.revision,
      ${displayNameSql} as "displayName", post.author_username as handle,
      coalesce(mail.id, post.id) as "sourceId", coalesce(mail.agent_id, post.agent_id) as "agentId",
      mail.thread_id as "threadId", post.run_id as "runId", post.provider_event_id as "postId",
      claim.payload as "claimEvidence"
    from person_identities identity ${latestPeopleSources}
    left join lateral (
      select jsonb_build_object('claim', entry.claim, 'sourceId', entry.id, 'agentId', entry.agent_id,
        'threadId', entry.thread_id, 'runId', entry.run_id, 'postId', entry.post_id) as payload
      from (
        select person_claim as claim, id, agent_id, thread_id, null::uuid as run_id,
          null::text as post_id, received_at as occurred_at
        from email_messages where person_identity_id = identity.id and person_claim is not null
        union all
        select person_claim, id, agent_id, null::uuid, run_id, provider_event_id,
          coalesce(provider_created_at, ingested_at)
        from source_events where person_identity_id = identity.id and person_claim is not null
      ) entry
      order by entry.occurred_at desc, entry.id desc limit 1
    ) claim on true
    where ${condition} order by (identity.home_person_id = identity.person_id) desc, identity.channel, identity.id
  `);
}

export async function getPerson(
  personId: string,
  page: number,
  agentId?: string,
  linkIdentityId?: string,
) {
  await requireAdmin();
  const store = db();
  const [person] = await store
    .select({ id: people.id })
    .from(people)
    .where(eq(people.id, personId));
  if (!person) return null;
  const [identities, contacts, agentsList, linkSources, changes] = await Promise.all([
    loadIdentities(sql`identity.person_id = ${personId}`),
    store
      .select()
      .from(personContacts)
      .where(eq(personContacts.personId, personId))
      .orderBy(asc(personContacts.kind), asc(personContacts.label)),
    store
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .orderBy(asc(agents.name), asc(agents.id)),
    linkIdentityId
      ? loadIdentities(sql`identity.id = ${linkIdentityId} and identity.person_id <> ${personId}`)
      : [],
    store
      .select()
      .from(personIdentityChanges)
      .where(
        or(
          eq(personIdentityChanges.fromPersonId, personId),
          eq(personIdentityChanges.toPersonId, personId),
        ),
      )
      .orderBy(desc(personIdentityChanges.createdAt), desc(personIdentityChanges.id))
      .limit(30),
  ]);
  if (!identities.length && !contacts.length) {
    const [current] = await store
      .select({ personId: personIdentities.personId })
      .from(personIdentities)
      .where(eq(personIdentities.homePersonId, personId));
    if (current && current.personId !== personId) return { movedTo: current.personId } as const;
    return null;
  }
  const selectedAgent = agentsList.find(({ id }) => id === agentId);
  const [history, memories] = await Promise.all([
    selectedAgent
      ? getPersonContextForAgent(selectedAgent.id, personId, page)
      : listPersonInteractions(personId, page).then((activity) => ({ ...activity, notes: [] })),
    selectedAgent ? selectPersonMemories(selectedAgent.id, personId) : [],
  ]);
  const evidenceKeys = changes.flatMap(({ evidence }) => evidence);
  const emailKeys = evidenceKeys
    .filter(({ channel }) => channel === 'email')
    .map(({ sourceId }) => sourceId);
  const eventKeys = evidenceKeys
    .filter(({ channel }) => channel !== 'email')
    .map(({ sourceId }) => sourceId);
  const [emails, posts] = await Promise.all([
    emailKeys.length
      ? store
          .select({
            id: emailMessages.id,
            agentId: emailMessages.agentId,
            threadId: emailMessages.threadId,
          })
          .from(emailMessages)
          .where(inArray(emailMessages.id, emailKeys))
      : [],
    eventKeys.length
      ? store
          .select({
            id: sourceEvents.id,
            agentId: sourceEvents.agentId,
            runId: sourceEvents.runId,
            postId: sourceEvents.providerEventId,
            channel: sourceEvents.provider,
          })
          .from(sourceEvents)
          .where(inArray(sourceEvents.id, eventKeys))
      : [],
  ]);
  const evidence = [
    ...emails.map((email) => ({ ...email, channel: 'email' as const, runId: null, postId: null })),
    ...posts.map((post) => ({ ...post, threadId: null })),
  ];
  return {
    ...history,
    memories,
    id: personId,
    name: identities[0]?.displayName ?? contacts[0].label,
    identities,
    contacts,
    agents: agentsList,
    selectedAgent,
    linkSource: linkSources[0],
    changes,
    evidence,
  };
}
