import { and, eq, sql } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { emailMessages, personRelationshipNotes, sourceEvents } from '@/lib/schema';

type ActivitySource = {
  agentId: string;
  agentName: string;
  threadId: string | null;
  runId: string | null;
  providerId: string;
  sourceId: string;
};
type ActivityKind = 'email' | 'reply' | 'x';
type Interaction = {
  kind: ActivityKind;
  eventKey: string;
  occurredAt: Date | string;
  title: string;
  sources: ActivitySource[];
};

const interactionsPerPage = 30;
const evaluatorContextLimit = 8;

export async function loadRelationshipContext(
  agentId: string,
  runId: string,
  origin: 'email' | 'discovery',
) {
  const current =
    origin === 'email'
      ? sql`select id, person_identity_id, received_at as observed_at
            from email_messages where agent_id = ${agentId} and run_id = ${runId}`
      : sql`select id, person_identity_id, ingested_at as observed_at
            from source_events where agent_id = ${agentId} and run_id = ${runId} and provider = 'x'`;
  // Resolve membership and read the agent's activity in one statement so a
  // concurrent correction cannot mix the old and new person in one request.
  const rows = await db().execute<{
    kind: ActivityKind;
    title: string;
    summary: string | null;
    observedAt: Date | string;
  }>(sql`
    with current_source as (${current}), identities as (
      select peer.id, current_source.id as current_id, current_source.observed_at
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
      select 'x', left(post.text, 280), note.summary, post.ingested_at, post.id
      from identities join source_events post on post.person_identity_id = identities.id
      left join person_relationship_notes note on note.source_event_id = post.id and note.agent_id = ${agentId}
      where post.agent_id = ${agentId} and post.provider = 'x' and post.id <> identities.current_id
        and post.ingested_at <= identities.observed_at
    ) activity
    order by activity.observed_at desc, activity.kind, activity.id
    limit ${evaluatorContextLimit}
  `);
  return rows;
}

export async function listPersonInteractions(personId: string, page: number, agentId?: string) {
  const emailScope = agentId ? sql`and email.agent_id = ${agentId}` : sql``;
  const xScope = agentId ? sql`and post.agent_id = ${agentId}` : sql``;
  const rows = await db().execute<Interaction>(sql`
    with identities as (
      select id from person_identities where person_id = ${personId}
    ), activity as (
      select 'email' as kind, email.resend_email_id as event_key, email.received_at as occurred_at,
        coalesce(nullif(email.subject, ''), '(No subject)') as title, email.agent_id,
        email.thread_id, null::uuid as run_id, email.resend_email_id as provider_id, email.id as source_id
      from email_messages email join identities on email.person_identity_id = identities.id
      where true ${emailScope}
      union all
      select 'reply', coalesce(reply.provider_message_id, reply.id::text),
        coalesce(reply.completed_at, reply.dispatched_at, reply.created_at),
        case when email.subject ~* '^re:' then email.subject else 'Re: ' || coalesce(nullif(email.subject, ''), '(No subject)') end,
        reply.agent_id, email.thread_id, null::uuid, coalesce(reply.provider_message_id, reply.id::text), email.id
      from email_messages email join identities on email.person_identity_id = identities.id
      join outbound_actions reply on reply.email_message_id = email.id and reply.agent_id = email.agent_id
      where reply.action_type = 'email.send' and reply.status = 'sent' ${emailScope}
      union all
      select 'x', post.provider_event_id, coalesce(post.provider_created_at, post.ingested_at),
        left(post.text, 280), post.agent_id, null::uuid, post.run_id, post.provider_event_id, post.id
      from source_events post join identities on post.person_identity_id = identities.id
      where post.provider = 'x' ${xScope}
    ), events as (
      select kind, event_key, max(occurred_at) as occurred_at, min(title) as title
      from activity group by kind, event_key
      order by occurred_at desc, kind, event_key
      limit ${interactionsPerPage + 1} offset ${(page - 1) * interactionsPerPage}
    )
    select events.kind, events.event_key as "eventKey", events.occurred_at as "occurredAt", events.title,
      jsonb_agg(jsonb_build_object(
        'agentId', activity.agent_id, 'agentName', agents.name, 'threadId', activity.thread_id,
        'runId', activity.run_id, 'providerId', activity.provider_id, 'sourceId', activity.source_id
      ) order by agents.name, activity.agent_id) as sources
    from events join activity using (kind, event_key) join agents on agents.id = activity.agent_id
    group by events.kind, events.event_key, events.occurred_at, events.title
    order by events.occurred_at desc, events.kind, events.event_key
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
    }>(sql`
      select note.id, note.summary, note.excerpt, note.created_at as "createdAt",
        coalesce(email.id, post.id) as "sourceId", email.thread_id as "threadId", post.run_id as "runId", post.provider_event_id as "postId"
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
  origin: 'email' | 'discovery',
  note: { summary: string; excerpt: string },
) {
  const [source] =
    origin === 'email'
      ? await tx
          .select({
            id: emailMessages.id,
            text: emailMessages.body,
            identity: emailMessages.personIdentityId,
          })
          .from(emailMessages)
          .where(and(eq(emailMessages.agentId, agentId), eq(emailMessages.runId, runId)))
      : await tx
          .select({
            id: sourceEvents.id,
            text: sourceEvents.text,
            identity: sourceEvents.personIdentityId,
          })
          .from(sourceEvents)
          .where(
            and(
              eq(sourceEvents.agentId, agentId),
              eq(sourceEvents.runId, runId),
              eq(sourceEvents.provider, 'x'),
            ),
          );
  if (!source?.identity || !source.text?.includes(note.excerpt)) return;
  await tx
    .insert(personRelationshipNotes)
    .values({
      agentId,
      emailMessageId: origin === 'email' ? source.id : null,
      sourceEventId: origin === 'discovery' ? source.id : null,
      summary: note.summary,
      excerpt: note.excerpt,
    })
    .onConflictDoNothing();
}
