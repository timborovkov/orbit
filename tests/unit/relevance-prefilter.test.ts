import { expect, test } from 'bun:test';

import {
  capDiscoveryPosts,
  extractRelevanceTerms,
  prefilterDiscoveryPosts,
  scoreDiscoveryRelevance,
} from '@/lib/runtime/x/relevance-prefilter';

test('extractRelevanceTerms drops stopwords and short tokens', () => {
  expect(extractRelevanceTerms('The AI agent found a founder in SaaS')).toEqual([
    'agent',
    'found',
    'founder',
    'saas',
  ]);
});

test('scoreDiscoveryRelevance requires overlap with mission criteria', () => {
  const criteria = {
    mission: 'Connect founders building agent tooling',
    engagementCriteria: 'SaaS founders discussing product launches',
  };
  const hit = scoreDiscoveryRelevance(
    'Looking for SaaS founders who ship agent tooling this quarter',
    criteria,
  );
  expect(hit.relevant).toBe(true);
  expect(hit.matchedTerms.length).toBeGreaterThan(0);

  const miss = scoreDiscoveryRelevance('Baseball scores and crypto prices tonight', criteria);
  expect(miss.relevant).toBe(false);
  expect(miss.score).toBe(0);
});

test('empty criteria skip the pre-filter', () => {
  expect(scoreDiscoveryRelevance('anything at all', {}).relevant).toBe(true);
});

test('prefilterDiscoveryPosts and capDiscoveryPosts enforce keep/drop/cap', () => {
  const posts = [
    { id: '1', text: 'SaaS founder launch for agents' },
    { id: '2', text: 'NATO summit baseball crypto' },
    { id: '3', text: 'Another founder building agents' },
  ];
  const { kept, dropped } = prefilterDiscoveryPosts(posts, {
    mission: 'Help founders ship agents',
    engagementCriteria: 'founder agent SaaS',
  });
  expect(dropped).toBe(1);
  expect(kept.map((post) => post.id)).toEqual(['1', '3']);
  expect(capDiscoveryPosts(kept, 1)).toHaveLength(1);
  expect(capDiscoveryPosts(kept, 50)).toHaveLength(2);
});
