import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { z } from 'zod';

import {
  addPersonContact,
  deletePersonContact,
  linkPersonIdentity,
  unlinkPersonIdentity,
} from '@/actions/people';
import { WorkspaceForm } from '@/app/workspace-form';
import { WorkspaceHeader } from '@/app/workspace-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { env } from '@/lib/env';
import { formatUtcTimestamp } from '@/lib/format';
import { channelAdapter, channelLabel } from '@/lib/runtime/channels/registry';
import { memoryEvidenceHref } from '@/lib/runtime/memory/types';
import { getPerson, personHref } from '@/lib/server/people-queries';
import { getPendingApprovalCount } from '@/lib/server/workspace-queries';

export const dynamic = 'force-dynamic';

type PersonView = Exclude<NonNullable<Awaited<ReturnType<typeof getPerson>>>, { movedTo: string }>;
type Identity = PersonView['identities'][number];

function sourceHref(source: {
  agentId: string | null;
  threadId: string | null;
  runId: string | null;
  postId: string | null;
  channel?: string;
  sourceId?: string | null;
}) {
  if (source.agentId && source.threadId) {
    const thread = `/agents/${source.agentId}?tab=email&emailThread=${source.threadId}`;
    return source.sourceId
      ? `${thread}&emailMessage=${source.sourceId}#message-${source.sourceId}`
      : thread;
  }
  if (source.agentId && source.runId) return `/agents/${source.agentId}?run=${source.runId}`;
  return source.postId
    ? (channelAdapter(source.channel)?.activity?.externalHref?.(source.postId) ?? null)
    : null;
}

function EvidenceLink({
  source,
  label,
}: {
  source: Parameters<typeof sourceHref>[0];
  label: string;
}) {
  const href = sourceHref(source);
  return href ? <Link href={href}>{label}</Link> : <span>{label}</span>;
}

function IdentityInputs({ name, identity }: { name: 'identity' | 'target'; identity: Identity }) {
  return (
    <>
      <input type="hidden" name={name} value={identity.id} />
      <input type="hidden" name={`${name}Source`} value={identity.sourceId ?? ''} />
      <input type="hidden" name={`${name}Revision`} value={identity.revision} />
    </>
  );
}

function IdentityEvidence({ identity }: { identity: Identity }) {
  return (
    <div>
      {identity.sourceId && (
        <EvidenceLink
          source={identity}
          label={
            identity.threadId
              ? 'Open source email thread'
              : `Open source ${channelLabel(identity.channel)} activity`
          }
        />
      )}
      {identity.claimEvidence && (
        <p>
          <EvidenceLink
            source={{ ...identity.claimEvidence, channel: identity.channel }}
            label={
              identity.channel === 'email'
                ? `Claimed X account @${identity.claimEvidence.claim}`
                : `Claimed email ${identity.claimEvidence.claim}`
            }
          />
        </p>
      )}
    </div>
  );
}

function LinkForm({
  identity,
  target,
  confirm = false,
}: {
  identity: Identity;
  target: Identity;
  confirm?: boolean;
}) {
  if (!identity.sourceId || !target.sourceId) return null;
  const field = `link-reason-${identity.id}-${target.id}`;
  return (
    <WorkspaceForm action={linkPersonIdentity} label={confirm ? 'Confirm link' : 'Link identity'}>
      <IdentityInputs name="identity" identity={identity} />
      <IdentityInputs name="target" identity={target} />
      <label htmlFor={field}>Reason for linking</label>
      <Input id={field} name="reason" required maxLength={1000} />
    </WorkspaceForm>
  );
}

function PersonIdentities({ person }: { person: PersonView }) {
  return (
    <section aria-labelledby="person-identities">
      <h2 id="person-identities">Identities</h2>
      {person.linkSource && (
        <div className="people-card">
          <strong>Link {person.linkSource.displayName}</strong>
          <IdentityEvidence identity={person.linkSource} />
          <p>Choose an identity below as evidence for this link.</p>
          <Link href={personHref(person.id)}>Cancel linking</Link>
        </div>
      )}
      {!person.identities.length && <p className="muted">No channel identities are linked.</p>}
      <ul className="people-list">
        {person.identities.map((identity) => {
          const peer = person.identities.find(({ id }) => id === identity.linkedViaId);
          const unlinkField = `unlink-reason-${identity.id}`;
          return (
            <li className="people-card" key={identity.id}>
              <div>
                <strong>{channelLabel(identity.channel)}</strong>
                <p>{identity.handle ? `@${identity.handle}` : identity.identityKey}</p>
                {identity.linkState !== 'standalone' && (
                  <span className="state-label">
                    {identity.linkState === 'inferred' ? 'Inferred link' : 'Confirmed link'}
                  </span>
                )}
              </div>
              <IdentityEvidence identity={identity} />
              {person.linkSource ? (
                <LinkForm identity={person.linkSource} target={identity} />
              ) : (
                <div className="people-identity-actions">
                  {identity.sourceId && (
                    <Link href={`/people?link=${identity.id}`}>Link to another person</Link>
                  )}
                  {identity.linkState === 'inferred' && peer && (
                    <details>
                      <summary>Confirm inferred link</summary>
                      <LinkForm identity={identity} target={peer} confirm />
                    </details>
                  )}
                  {identity.sourceId && identity.linkState !== 'standalone' && (
                    <details>
                      <summary>Unlink identity</summary>
                      <WorkspaceForm action={unlinkPersonIdentity} label="Unlink identity">
                        <IdentityInputs name="identity" identity={identity} />
                        <label htmlFor={unlinkField}>Reason for unlinking</label>
                        <Input id={unlinkField} name="reason" maxLength={1000} required />
                      </WorkspaceForm>
                    </details>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PersonContacts({ person }: { person: PersonView }) {
  return (
    <section aria-labelledby="person-contacts">
      <h2 id="person-contacts">Contact methods</h2>
      {person.contacts.length > 0 && (
        <ul className="people-list">
          {person.contacts.map((contact) => (
            <li className="people-card people-contact" key={contact.id}>
              <div>
                <strong>{contact.kind === 'phone' ? 'Phone · SMS and voice' : 'Instagram'}</strong>
                <p>{contact.label}</p>
                {contact.providerAccountId && (
                  <p className="muted">Account ID {contact.providerAccountId}</p>
                )}
              </div>
              <WorkspaceForm action={deletePersonContact} label="Remove contact">
                <input type="hidden" name="personId" value={person.id} />
                <input type="hidden" name="contactId" value={contact.id} />
              </WorkspaceForm>
            </li>
          ))}
        </ul>
      )}
      <div className="people-identity-actions">
        <details>
          <summary>Add a phone number</summary>
          <WorkspaceForm action={addPersonContact} label="Add phone number">
            <input type="hidden" name="personId" value={person.id} />
            <input type="hidden" name="kind" value="phone" />
            <label htmlFor="person-phone">Phone number in international format</label>
            <Input
              id="person-phone"
              type="tel"
              name="label"
              placeholder="+442079460000"
              required
              maxLength={16}
            />
          </WorkspaceForm>
        </details>
        <details>
          <summary>Add an Instagram account</summary>
          <WorkspaceForm action={addPersonContact} label="Add Instagram account">
            <input type="hidden" name="personId" value={person.id} />
            <input type="hidden" name="kind" value="instagram" />
            <label htmlFor="person-instagram">Instagram handle</label>
            <Input id="person-instagram" name="label" maxLength={31} required />
            <label htmlFor="person-instagram-id">Instagram account ID (optional)</label>
            <Input id="person-instagram-id" name="providerAccountId" maxLength={128} />
          </WorkspaceForm>
        </details>
      </div>
    </section>
  );
}

function PersonLinkHistory({ person }: { person: PersonView }) {
  const labels = {
    infer: 'Inferred link',
    confirm: 'Confirmed link',
    unlink: 'Unlinked identity',
    rollback: 'Rolled back inference',
  };
  if (!person.changes.length) return null;
  return (
    <section aria-labelledby="person-link-history">
      <h2 id="person-link-history">Identity link history</h2>
      <ul className="people-list">
        {person.changes.map((change) => (
          <li className="people-card" key={change.id}>
            <strong>{labels[change.action]}</strong>
            <p>{change.reason}</p>
            <p className="muted">
              <time dateTime={change.createdAt.toISOString()}>
                {formatUtcTimestamp(change.createdAt)}
              </time>{' '}
              · {change.actor}
            </p>
            <ul className="people-evidence-list">
              {change.evidence.map(({ channel, sourceId }) => {
                const source = person.evidence.find(
                  ({ id, channel: sourceChannel }) => id === sourceId && sourceChannel === channel,
                );
                return (
                  <li key={`${channel}:${sourceId}`}>
                    {source ? (
                      <EvidenceLink
                        source={{ ...source, sourceId }}
                        label={`${channelLabel(channel)} evidence`}
                      />
                    ) : (
                      'Source no longer available'
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function interactionLabel(channel: string, sent: boolean) {
  const activity = channelAdapter(channel)?.activity;
  const label = channelLabel(channel);
  return sent ? (activity?.sentLabel ?? `Sent via ${label}`) : (activity?.receivedLabel ?? label);
}

function PersonTimeline({ person, page }: { person: PersonView; page: number }) {
  const selectedAgent = person.selectedAgent;
  function pageHref(number: number) {
    const params = new URLSearchParams();
    if (person.selectedAgent) params.set('agent', person.selectedAgent.id);
    if (number > 1) params.set('page', String(number));
    const suffix = params.toString();
    return suffix ? `${personHref(person.id)}?${suffix}` : personHref(person.id);
  }

  return (
    <div className="people-timeline">
      <section aria-labelledby="person-timeline">
        <h2 id="person-timeline">Timeline</h2>
        <form action={personHref(person.id)} method="get" className="people-control-row">
          <label htmlFor="people-agent">Agent</label>
          <select
            id="people-agent"
            name="agent"
            className="people-agent-select"
            defaultValue={person.selectedAgent?.id ?? ''}
          >
            <option value="">All agents</option>
            {person.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline">
            Set agent
          </Button>
        </form>
        {!person.interactions.length && <p className="muted">No interactions to show.</p>}
        <ol className="people-list">
          {person.interactions.map((interaction) => (
            <li
              className="people-card"
              key={`${interaction.channel}:${interaction.sent}:${interaction.eventKey}`}
            >
              <div className="people-heading">
                <span className="state-label">
                  {interactionLabel(interaction.channel, interaction.sent)}
                </span>
                <time className="muted" dateTime={new Date(interaction.occurredAt).toISOString()}>
                  {formatUtcTimestamp(interaction.occurredAt)}
                </time>
              </div>
              <p className="preserve-text">{interaction.title}</p>
              <ul className="people-evidence-list">
                {interaction.sources.map((source) => (
                  <li key={`${source.agentId}:${source.sourceId}`}>
                    <EvidenceLink
                      source={{
                        ...source,
                        channel: interaction.channel,
                        postId: interaction.sent ? null : source.providerId,
                      }}
                      label={source.agentName}
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>
      {selectedAgent && person.memories.length > 0 && (
        <section aria-labelledby="person-private-memory">
          <h2 id="person-private-memory">Private memory facts</h2>
          <ul className="people-list">
            {person.memories.map((memory) => (
              <li className="people-card" key={memory.id}>
                <strong>{memory.topic}</strong>
                <p>{memory.value}</p>
                <Link href={memoryEvidenceHref(selectedAgent.id, memory)}>
                  View original source
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {person.selectedAgent && (
        <section aria-labelledby="person-private-notes">
          <h2 id="person-private-notes">Private relationship notes</h2>
          {!person.notes.length && (
            <p className="muted">No private notes for {person.selectedAgent.name}.</p>
          )}
          <ul className="people-list">
            {person.notes.map((note) => (
              <li className="people-card" key={note.id}>
                <p>{note.summary}</p>
                <blockquote>{note.excerpt}</blockquote>
                <EvidenceLink
                  source={{ ...note, agentId: person.selectedAgent?.id ?? null }}
                  label="Open supporting interaction"
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {(page > 1 || person.hasOlder) && (
        <nav className="people-control-row" aria-label="Timeline pages">
          {page > 1 && (
            <Button variant="outline" asChild>
              <Link href={pageHref(page - 1)}>Newer</Link>
            </Button>
          )}
          {person.hasOlder && (
            <Button variant="outline" asChild>
              <Link href={pageHref(page + 1)}>Older</Link>
            </Button>
          )}
        </nav>
      )}
    </div>
  );
}

export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ agent?: string; page?: string; link?: string }>;
}) {
  const [{ id }, search] = await Promise.all([params, searchParams]);
  if (!z.uuid().safeParse(id).success) notFound();
  const agent = z.uuid().safeParse(search.agent).data;
  const link = z.uuid().safeParse(search.link).data;
  const page = z.coerce.number().int().min(1).max(100_000).safeParse(search.page).data ?? 1;
  const [person, pendingApprovalCount] = await Promise.all([
    getPerson(id, page, agent, link),
    getPendingApprovalCount(),
  ]);
  if (!person) notFound();
  if (!('name' in person)) redirect(personHref(person.movedTo));

  return (
    <div className="agent-shell">
      <WorkspaceHeader current="/people" pendingApprovalCount={pendingApprovalCount} />
      <main className="workspace-main people-workspace" id="main" tabIndex={-1}>
        {env().AUTH_DISABLED && (
          <p className="local-auth-notice" role="status">
            Authentication disabled · Local development
          </p>
        )}
        <nav className="agent-breadcrumb" aria-label="Breadcrumb">
          <Link href="/people">People</Link>
        </nav>
        <h1>{person.name}</h1>
        <div className="people-detail">
          <PersonTimeline person={person} page={page} />
          {!person.selectedAgent && (
            <aside className="people-sidebar">
              <PersonIdentities person={person} />
              <PersonContacts person={person} />
              <PersonLinkHistory person={person} />
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}
