import { expect, test } from 'bun:test';

import {
  listValuesFromForm,
  parseWebResearchSeeds,
  webResearchSeedGuidance,
} from '@/lib/runtime/research/seeds';

test('parseWebResearchSeeds normalizes invalid input', () => {
  expect(parseWebResearchSeeds(null)).toEqual({ queries: [], sources: [] });
  expect(
    parseWebResearchSeeds({
      queries: ['  agents  ', '', 'observability'],
      sources: ['https://example.com'],
    }),
  ).toEqual({
    queries: ['agents', 'observability'],
    sources: ['https://example.com'],
  });
});

test('listValuesFromForm reads repeated fields and drops blanks', () => {
  const form = new FormData();
  form.append('seedQuery', ' one ');
  form.append('seedQuery', '');
  form.append('seedQuery', 'two');
  expect(listValuesFromForm(form, 'seedQuery')).toEqual(['one', 'two']);
});

test('webResearchSeedGuidance formats prompt guidance', () => {
  expect(webResearchSeedGuidance({ queries: [], sources: [] })).toBeNull();
  expect(
    webResearchSeedGuidance({
      queries: ['agent evals'],
      sources: ['https://docs.example.com'],
    }),
  ).toContain('Preferred search queries');
});
