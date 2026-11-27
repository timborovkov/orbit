import { expect, test } from 'bun:test';

import { formatAge } from '@/lib/format';

test('formatAge advances when the reference time refreshes', () => {
  const createdAt = '2026-11-26T12:00:00.000Z';
  const firstRender = new Date('2026-11-26T12:00:05.000Z');
  const afterRefresh = new Date('2026-11-26T12:02:00.000Z');

  expect(formatAge(createdAt, firstRender)).toBe('5s');
  expect(formatAge(createdAt, afterRefresh)).toBe('2m');
});
