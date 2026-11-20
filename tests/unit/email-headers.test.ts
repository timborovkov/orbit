import { expect, test } from 'bun:test';

import {
  extractEmailAddress,
  replySubject,
  replyThreadingHeaders,
  sendingDomainMatches,
} from '@/lib/runtime/email/headers';

test('extractEmailAddress reads angle-bracket and bare addresses', () => {
  expect(extractEmailAddress('Ada <ada@example.test>')).toBe('ada@example.test');
  expect(extractEmailAddress('ada@example.test')).toBe('ada@example.test');
  expect(extractEmailAddress('not-an-email')).toBeNull();
});

test('replySubject prefixes Re: once', () => {
  expect(replySubject('Invoice help')).toBe('Re: Invoice help');
  expect(replySubject('Re: Invoice help')).toBe('Re: Invoice help');
  expect(replySubject('')).toBe('Re: (No subject)');
});

test('replyThreadingHeaders derive In-Reply-To and References from inbound only', () => {
  expect(
    replyThreadingHeaders({
      messageId: 'msg-3@example.test',
      inReplyTo: ['msg-2@example.test'],
      referenceIds: ['msg-1@example.test'],
    }),
  ).toEqual({
    inReplyTo: '<msg-3@example.test>',
    references: '<msg-1@example.test> <msg-2@example.test> <msg-3@example.test>',
  });
  expect(replyThreadingHeaders({ messageId: null, inReplyTo: [], referenceIds: [] })).toEqual({
    inReplyTo: null,
    references: null,
  });
});

test('sendingDomainMatches enforces optional domain', () => {
  expect(sendingDomainMatches('a@inbound.example.test', undefined)).toBe(true);
  expect(sendingDomainMatches('a@inbound.example.test', 'inbound.example.test')).toBe(true);
  expect(sendingDomainMatches('a@other.example.test', 'inbound.example.test')).toBe(false);
});
