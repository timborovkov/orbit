import Link from 'next/link';

import { updateEmailMailbox } from '@/actions/email';
import { KnowledgeCitations } from '@/app/knowledge-citations';
import { WorkspaceForm } from '@/app/workspace-form';
import { Button } from '@/components/ui/button';
import { formatUtcTimestamp } from '@/lib/format';
import type { getEmailInbox } from '@/lib/server/email-queries';

type Inbox = Awaited<ReturnType<typeof getEmailInbox>>;
type InboxUrl = (thread: string | undefined, threadPage?: number, messagePage?: number) => string;

function MailboxSettings({
  agentId,
  mailbox,
  configured,
}: Pick<Inbox, 'mailbox' | 'configured'> & { agentId: string }) {
  const enabled = mailbox?.enabled ?? false;
  return (
    <section className="email-mailbox" aria-labelledby="mailbox-heading">
      <div>
        <h2 id="mailbox-heading">Inbound email</h2>
        <p className="muted">Replies are saved as drafts in Shadow and Live.</p>
        {mailbox && <p className="email-address">{mailbox.address}</p>}
        {!configured && <p className="muted">Configure Resend receiving to enable email.</p>}
      </div>
      <WorkspaceForm
        action={updateEmailMailbox}
        label={enabled ? 'Disable email' : 'Enable email'}
        disabled={!enabled && !configured}
      >
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="enabled" value={String(!enabled)} />
      </WorkspaceForm>
    </section>
  );
}

function ThreadList({ inbox, page, inboxUrl }: { inbox: Inbox; page: number; inboxUrl: InboxUrl }) {
  return (
    <section aria-labelledby="email-threads-heading">
      <h2 id="email-threads-heading">Threads</h2>
      {!inbox.threads.length && <p className="muted">No email received yet.</p>}
      {inbox.threads.length > 0 && (
        <ul className="email-thread-list">
          {inbox.threads.map((thread) => (
            <li key={thread.id}>
              <Link
                href={inboxUrl(thread.id)}
                aria-current={thread.id === inbox.selectedId ? 'true' : undefined}
              >
                <strong>{thread.subject || '(No subject)'}</strong>
                <span className="muted">{thread.sender}</span>
                <time className="muted" dateTime={thread.receivedAt.toISOString()}>
                  {formatUtcTimestamp(thread.receivedAt)}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {(page > 1 || inbox.hasOlderThreads) && (
        <nav className="email-pagination" aria-label="Thread pages">
          {page > 1 && (
            <Button variant="outline" asChild>
              <Link href={inboxUrl(undefined, page - 1)}>Newer threads</Link>
            </Button>
          )}
          {inbox.hasOlderThreads && (
            <Button variant="outline" asChild>
              <Link href={inboxUrl(undefined, page + 1)}>Older threads</Link>
            </Button>
          )}
        </nav>
      )}
    </section>
  );
}

function SelectedThread({
  inbox,
  page,
  messagePage,
  inboxUrl,
}: {
  inbox: Inbox;
  page: number;
  messagePage: number;
  inboxUrl: InboxUrl;
}) {
  if (!inbox.selectedId) return null;
  return (
    <section aria-labelledby="email-thread-heading">
      <h2 id="email-thread-heading">Thread</h2>
      {(messagePage > 1 || inbox.hasOlderMessages) && (
        <nav className="email-pagination" aria-label="Message pages">
          {messagePage > 1 && (
            <Button variant="outline" asChild>
              <Link href={inboxUrl(inbox.selectedId, page, messagePage - 1)}>Newer messages</Link>
            </Button>
          )}
          {inbox.hasOlderMessages && (
            <Button variant="outline" asChild>
              <Link href={inboxUrl(inbox.selectedId, page, messagePage + 1)}>Older messages</Link>
            </Button>
          )}
        </nav>
      )}
      {inbox.messages.map((message) => (
        <article className="email-message" key={message.id}>
          <header className="email-message-heading">
            <div>
              <h3>{message.subject || '(No subject)'}</h3>
              <p className="muted">
                {message.sender} ·{' '}
                <time dateTime={message.receivedAt.toISOString()}>
                  {formatUtcTimestamp(message.receivedAt)}
                </time>
              </p>
            </div>
            <span className="state-label">{message.status}</span>
          </header>
          {!!message.body && <p className="preserve-text">{message.body}</p>}
          {message.detail && <p className="muted">{message.detail}</p>}
          {message.draft && (
            <section className="email-draft">
              <h4>Reply draft</h4>
              <p className="preserve-text">{message.draft.answer}</p>
              <KnowledgeCitations sources={message.draft.sources} />
            </section>
          )}
        </article>
      ))}
    </section>
  );
}

export function EmailInbox({
  agentId,
  inbox,
  page,
  messagePage,
}: {
  agentId: string;
  inbox: Inbox;
  page: number;
  messagePage: number;
}) {
  const inboxUrl: InboxUrl = (thread, threadPage = page, messages = 1) => {
    const query = new URLSearchParams({ tab: 'email' });
    if (thread) query.set('emailThread', thread);
    if (threadPage > 1) query.set('emailPage', String(threadPage));
    if (messages > 1) query.set('messagePage', String(messages));
    return `/agents/${agentId}?${query}`;
  };

  return (
    <div className="email-inbox">
      <MailboxSettings agentId={agentId} mailbox={inbox.mailbox} configured={inbox.configured} />
      <ThreadList inbox={inbox} page={page} inboxUrl={inboxUrl} />
      <SelectedThread inbox={inbox} page={page} messagePage={messagePage} inboxUrl={inboxUrl} />
    </div>
  );
}
