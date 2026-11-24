import { expect, test } from 'bun:test';

import { personInitials, relevanceSnippet } from '@/lib/people-display';

test('person initials come from the first two words', () => {
  expect(personInitials('Ada Lovelace')).toBe('AL');
  expect(personInitials('@ada_lovelace')).toBe('AL');
  expect(personInitials('ada@example.test')).toBe('A');
  expect(personInitials('Émile Zola Jr')).toBe('ÉZ');
  expect(personInitials('@@')).toBe('?');
});

test('relevance snippets collapse whitespace, truncate and omit blanks', () => {
  expect(relevanceSnippet('  needs\n a   quote ')).toBe('needs a quote');
  expect(relevanceSnippet('   ')).toBeNull();
  expect(relevanceSnippet(null)).toBeNull();
  const long = relevanceSnippet('word '.repeat(100));
  expect(long?.endsWith('…')).toBe(true);
  expect(Array.from(long ?? '').length).toBeLessThanOrEqual(140);
});
