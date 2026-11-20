/** Derive reply destination and threading headers from a stored inbound message. */

export function extractEmailAddress(sender: string): string | null {
  const angle = /<([^<>\s@]+@[^<>\s@]+)>/.exec(sender);
  const candidate = (angle?.[1] ?? sender).trim().toLowerCase();
  if (!/^[^<>\s@]+@[^<>\s@]+$/.test(candidate) || candidate.length > 320) return null;
  return candidate;
}

export function replySubject(subject: string): string {
  const trimmed = subject.trim() || '(No subject)';
  return /^re:\s/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function formatMessageIdHeader(id: string): string {
  const bare = id.replace(/^<|>$/g, '').trim();
  return `<${bare}>`;
}

/**
 * Build In-Reply-To and References from the inbound message only.
 * Never accept these from editable administrator or model input.
 */
export function replyThreadingHeaders(message: {
  messageId: string | null;
  inReplyTo: string[];
  referenceIds: string[];
}): { inReplyTo: string | null; references: string | null } {
  const messageId = message.messageId?.trim() ? message.messageId.trim() : null;
  if (!messageId) return { inReplyTo: null, references: null };

  const chain = [...message.referenceIds, ...message.inReplyTo, messageId]
    .map((id) => id.replace(/^<|>$/g, '').trim())
    .filter(Boolean);
  const unique = [...new Set(chain)].slice(-100);
  return {
    inReplyTo: formatMessageIdHeader(messageId),
    references: unique.map(formatMessageIdHeader).join(' '),
  };
}

export function sendingDomainMatches(
  mailboxAddress: string,
  sendingDomain: string | undefined,
): boolean {
  if (!sendingDomain) return true;
  const at = mailboxAddress.lastIndexOf('@');
  if (at < 0) return false;
  return mailboxAddress.slice(at + 1).toLowerCase() === sendingDomain.toLowerCase();
}
