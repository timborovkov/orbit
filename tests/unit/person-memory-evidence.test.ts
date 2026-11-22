import { expect, test } from 'bun:test';

import { supportsPersonFact } from '@/lib/runtime/memory/person-source';

test('person facts require the sender’s own assertion of the complete value and field', () => {
  const quote = 'I work at Northstar Labs as a Staff Engineer.';
  const body = `Jordan works at Acme. ${quote}`;
  expect(supportsPersonFact(body, 'Jordan works at Acme.', 'company', 'Acme')).toBe(false);
  expect(supportsPersonFact(body, quote, 'company', 'Northstar Labs')).toBe(true);
  expect(supportsPersonFact(body, 'I work at Northstar Labs', 'company', 'Northstar Labs')).toBe(
    true,
  );
  expect(supportsPersonFact(body, quote, 'company', 'Northstar')).toBe(false);
  expect(supportsPersonFact(body, quote, 'company', 'Staff Engineer')).toBe(false);
  expect(supportsPersonFact(body, quote, 'job_title', 'Staff Engineer')).toBe(true);
  expect(supportsPersonFact(body, quote, 'job_title', 'Engineer')).toBe(false);
  expect(supportsPersonFact(body, 'as a Staff Engineer', 'job_title', 'Staff Engineer')).toBe(
    false,
  );
  const contraction = 'I’m a Software Engineer at Acme.';
  expect(supportsPersonFact(contraction, contraction, 'company', 'Acme')).toBe(true);
  expect(supportsPersonFact(contraction, contraction, 'job_title', 'Software Engineer')).toBe(true);
});

test('quotation, forwarding, questions and negation do not establish person facts', () => {
  const quote = 'I work at Acme.';
  for (const body of [
    `Jordan told me “${quote}”`,
    `Here's what Jordan wrote:\n> ${quote}`,
    `Here's what Jordan wrote:\n----- Forwarded message -----\n${quote}`,
    'Look at this code:\n```text\n' + quote + '\n```',
  ]) {
    expect(supportsPersonFact(body, quote, 'company', 'Acme')).toBe(false);
  }
  for (const body of ['I work at Acme?', 'I do not work at Acme.', 'I worked at Acme.']) {
    expect(supportsPersonFact(body, body, 'company', 'Acme')).toBe(false);
  }
});
