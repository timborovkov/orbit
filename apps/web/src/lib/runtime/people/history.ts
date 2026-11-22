import { sql } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';

type ActivitySource = {
  agentId: string;
  agentName: string;
  threadId: string | null;
  runId: string | null;
  providerId: string;
  sourceId: string;
};
type ActivityKind = string;
type Interaction = {
  kind: ActivityKind;
  channel: string;
  sent: boolean;
  eventKey: string;
  occurredAt: Date | string;
  title: string;
  sources: ActivitySource[];
};

const interactionsPerPage = 30;
const evaluatorContextLimit = 8;

export async function loadRelationshipContext(agentId: string, runId: string) {
  // Resolve membership and read the agent's activity in one statement so a
  // concurrent correction cannot mix the old and new person in one request.
  const rows = await db().execute<{
    kind: ActivityKind;
    title: string;
    summary: string | null;
    observedAt: Date | string;
  }>(sql`
    with current_source as (
      select evidence.source_id as id, evidence.person_identity_id, evidence.observed_at,
        event.provider, event.account_id, event.thread_id
      from run_memory_evidence evidence
      left join source_events event on evidence.source_kind = 'event' and event.id = evidence.source_id
        and event.agent_id = evidence.agent_id
      where evidence.agent_id = ${agentId} and evidence.run_id = ${runId}
    ), identities as (
      select peer.id, current_source.id as current_id, current_source.observed_at,
        current_source.provider, current_source.account_id, current_source.thread_id
      from current_source
      join person_identities current_identity on current_identity.id = current_source.person_identity_id
      join person_identities peer on peer.person_id = current_identity.person_id
    ), prior_email as (
      select email.id, email.subject, email.received_at, identities.observed_at as cutoff
      from identities join email_messages email on email.person_identity_id = identities.id
      where email.agent_id = ${agentId} and email.id <> identities.current_id
        and email.received_at <= identities.observed_at and email.body is not null
    )
    select activity.kind, activity.title, activity.summary, activity.observed_at as "observedAt"
    from (
      select 'email' as kind, left(coalesce(nullif(email.subject, ''), '(No subject)'), 280) as title, note.summary,
        email.received_at as observed_at, email.id
      from prior_email email left join person_relationship_notes note
        on note.email_message_id = email.id and note.agent_id = ${agentId}
      union all
      select 'reply', left(coalesce(nullif(email.subject, ''), '(No subject)'), 280), null,
        coalesce(reply.completed_at, reply.dispatched_at, reply.created_at), reply.id
      from prior_email email join outbound_actions reply on reply.email_message_id = email.id
      where reply.agent_id = ${agentId} and reply.action_type = 'email.send' and reply.status = 'sent'
        and coalesce(reply.completed_at, reply.dispatched_at, reply.created_at) <= email.cutoff
      union all
      select post.provider, left(post.text, 280), note.summary, post.ingested_at, post.id
      from identities join source_events post on post.person_identity_id = identities.id
      left join person_relationship_notes note on note.source_event_id = post.id and note.agent_id = ${agentId}
      where post.agent_id = ${agentId} and post.id <> identities.current_id
        and (identities.thread_id is null or post.provider <> identities.provider
          or (post.thread_id = identities.thread_id and post.account_id is not distinct from identities.account_id))
        and post.ingested_at <= identities.observed_at
      union all
      select 'reply', left(post.text, 280), null,
        coalesce(reply.completed_at, reply.dispatched_at, reply.created_at), reply.id
      from identities join source_events post on post.person_identity_id = identities.id
      join action_intents intent on intent.run_id = post.run_id and intent.agent_id = post.agent_id
      join outbound_actions reply on reply.intent_id = intent.id and reply.agent_id = post.agent_id
      where post.agent_id = ${agentId} and post.id <> identities.current_id
        and (identities.thread_id is null or post.provider <> identities.provider
          or (post.thread_id = identities.thread_id and post.account_id is not distinct from identities.account_id))
        and reply.status = 'sent' and reply.email_message_id is null
        and intent.recipients ? post.author_id
        and coalesce(reply.completed_at, reply.dispatched_at, reply.created_at) <= identities.observed_at
    ) activity
    order by activity.observed_at desc, activity.kind, activity.id
    limit ${evaluatorContextLimit}
  `);
  return rows;
}

export async function listPersonInteractions(personId: string, page: number, agentId?: string) {
  const emailScope = agentId ? sql`and email.agent_id = ${agentId}` : sql``;
  const eventScope = agentId ? sql`and post.agent_id = ${agentId}` : sql``;
  const rows = await db().execute<Interaction>(sql`
    with identities as (
      select id from person_identities where person_id = ${personId}
    ), activity as (
      select 'email' as kind, email.resend_email_id as event_key, email.received_at as occurred_at,
        coalesce(nullif(email.subject, ''), '(No subject)') as title, email.agent_id,
        email.thread_id, null::uuid as run_id, email.resend_email_id as provider_id, email.id as source_id,
        'email' as channel, false as sent
      from email_messages email join identities on email.person_identity_id = identities.id
      where true ${emailScope}
      union all
      select 'reply', coalesce(reply.provider_message_id, reply.id::text),
        coalesce(reply.completed_at, reply.dispatched_at, reply.created_at),
        case when email.subject ~* '^re:' then email.subject else 'Re: ' || coalesce(nullif(email.subject, ''), '(No subject)') end,
        reply.agent_id, email.thread_id, null::uuid, coalesce(reply.provider_message_id, reply.id::text), email.id,
        'email', true
      from email_messages email join identities on email.person_identity_id = identities.id
      join outbound_actions reply on reply.email_message_id = email.id and reply.agent_id = email.agent_id
      where reply.action_type = 'email.send' and reply.status = 'sent' ${emailScope}
      union all
      select post.provider, post.provider_event_id, coalesce(post.provider_created_at, post.ingested_at),
        left(post.text, 280), post.agent_id, null::uuid, post.run_id, post.provider_event_id, post.id,
        post.provider, false
      from source_events post join identities on post.person_identity_id = identities.id
      where true ${eventScope}
      union all
      select 'reply', reply.id::text, coalesce(reply.completed_at, reply.dispatched_at, reply.created_at),
        coalesce(nullif(left(reply.body, 280), ''), reply.action_type), reply.agent_id,
        null::uuid, post.run_id, coalesce(reply.provider_message_id, reply.id::text), post.id,
        post.provider, true
      from source_events post join identities on post.person_identity_id = identities.id
      join action_intents intent on intent.run_id = post.run_id and intent.agent_id = post.agent_id
      join outbound_actions reply on reply.intent_id = intent.id and reply.agent_id = post.agent_id
      where reply.status = 'sent' and reply.email_message_id is null
        and intent.recipients ? post.author_id ${eventScope}
    ), events as (
      select kind, channel, sent, event_key, max(occurred_at) as occurred_at, min(title) as title
      from activity group by kind, channel, sent, event_key
      order by occurred_at desc, channel, kind, event_key
      limit ${interactionsPerPage + 1} offset ${(page - 1) * interactionsPerPage}
    )
    select events.kind, events.channel, events.sent, events.event_key as "eventKey", events.occurred_at as "occurredAt", events.title,
      jsonb_agg(jsonb_build_object(
        'agentId', activity.agent_id, 'agentName', agents.name, 'threadId', activity.thread_id,
        'runId', activity.run_id, 'providerId', activity.provider_id, 'sourceId', activity.source_id
      ) order by agents.name, activity.agent_id) as sources
    from events join activity using (kind, channel, sent, event_key) join agents on agents.id = activity.agent_id
    group by events.kind, events.channel, events.sent, events.event_key, events.occurred_at, events.title
    order by events.occurred_at desc, events.channel, events.kind, events.event_key
  `);
  return {
    interactions: rows.slice(0, interactionsPerPage),
    hasOlder: rows.length > interactionsPerPage,
  };
}

export async function getPersonContextForAgent(agentId: string, personId: string, page = 1) {
  const [history, notes] = await Promise.all([
    listPersonInteractions(personId, page, agentId),
    db().execute<{
      id: string;
      sourceId: string;
      summary: string;
      excerpt: string;
      createdAt: Date | string;
      threadId: string | null;
      runId: string | null;
      postId: string | null;
      channel: string;
    }>(sql`
      select note.id, note.summary, note.excerpt, note.created_at as "createdAt",
        coalesce(email.id, post.id) as "sourceId", email.thread_id as "threadId", post.run_id as "runId", post.provider_event_id as "postId",
        identity.channel
      from person_relationship_notes note
      left join email_messages email on email.id = note.email_message_id and email.agent_id = note.agent_id
      left join source_events post on post.id = note.source_event_id and post.agent_id = note.agent_id
      join person_identities identity on identity.id = coalesce(email.person_identity_id, post.person_identity_id)
      where note.agent_id = ${agentId} and identity.person_id = ${personId}
      order by note.created_at desc, note.id desc
      limit ${interactionsPerPage} offset ${(page - 1) * interactionsPerPage}
    `),
  ]);
  return { ...history, notes };
}

export async function storeRelationshipNote(
  tx: Tx,
  agentId: string,
  runId: string,
  note: { summary: string; excerpt: string },
) {
  await tx.execute(sql`
    INSERT INTO person_relationship_notes (agent_id, email_message_id, source_event_id, summary, excerpt)
    SELECT agent_id,
      CASE WHEN source_kind = 'email' THEN source_id END,
      CASE WHEN source_kind = 'event' THEN source_id END,
      ${note.summary}, ${note.excerpt}
    FROM run_memory_evidence
    WHERE agent_id = ${agentId} AND run_id = ${runId}
      AND person_identity_id IS NOT NULL AND strpos(body, ${note.excerpt}) > 0
    ON CONFLICT DO NOTHING
  `);
}
