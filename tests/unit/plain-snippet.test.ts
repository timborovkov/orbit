import { expect, test } from 'bun:test';

import { decodeHtmlEntities, plainTextSnippet } from '@/lib/text/plain-snippet';

test('decodeHtmlEntities handles named and numeric entities', () => {
  expect(decodeHtmlEntities('&lt;p&gt;Hello&amp;nbsp;world&lt;/p&gt;')).toBe('<p>Hello world</p>');
  expect(decodeHtmlEntities('&#60;b&#62;x&#60;/b&#62;')).toBe('<b>x</b>');
  expect(decodeHtmlEntities('&#x3C;i&#x3E;y&#x3C;/i&#x3E;')).toBe('<i>y</i>');
});

test('plainTextSnippet strips tags and truncates', () => {
  const raw =
    '&lt;p class="wp-block-paragraph"&gt;Hello from &lt;strong&gt;Orbit&lt;/strong&gt;&lt;/p&gt;';
  expect(plainTextSnippet(raw)).toBe('Hello from Orbit');
  expect(plainTextSnippet('<script>alert(1)</script>Safe')).toBe('Safe');
  expect(plainTextSnippet('   ')).toBe('');
  expect(plainTextSnippet(null)).toBe('');
  const long = plainTextSnippet('word '.repeat(80), 40);
  expect(long.endsWith('…')).toBe(true);
  expect(Array.from(long).length).toBeLessThanOrEqual(40);
});
