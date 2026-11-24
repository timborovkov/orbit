/**
 * Cheap, deterministic relevance gate for X discovery posts.
 * Runs before full evaluator/main inference so irrelevant matches do not burn request quota.
 */

export type RelevanceCriteria = {
  mission?: string;
  engagementCriteria?: string;
  /** Optional extra phrases (e.g. query keywords) treated as soft signals. */
  hints?: string[];
};

export type RelevanceDecision = {
  relevant: boolean;
  score: number;
  matchedTerms: string[];
  reason: string;
};

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'my',
  'your',
  'our',
  'their',
  'not',
  'no',
  'yes',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'will',
  'just',
  'about',
  'into',
  'over',
  'after',
  'before',
  'than',
  'then',
  'also',
  'very',
  'more',
  'most',
  'such',
  'via',
  'http',
  'https',
  'www',
  'com',
  'rt',
]);

/** Extract meaningful tokens (length ≥ 3, not stopwords). */
export function extractRelevanceTerms(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9'+-]{2,}/g) ?? []) {
    const term = raw.replace(/^'+|'+$/g, '');
    if (term.length < 3 || STOPWORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function criteriaTerms(criteria: RelevanceCriteria): string[] {
  const blobs = [criteria.mission, criteria.engagementCriteria, ...(criteria.hints ?? [])]
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n');
  return extractRelevanceTerms(blobs);
}

/**
 * Score a post against mission/engagement text.
 * Requires at least one shared term when criteria exist; empty criteria always pass.
 */
export function scoreDiscoveryRelevance(
  postText: string,
  criteria: RelevanceCriteria,
): RelevanceDecision {
  if (criteria.hints?.some((hint) => hint.trim() === '*')) {
    return {
      relevant: true,
      score: 1,
      matchedTerms: [],
      reason: 'Wildcard query bypasses pre-filter.',
    };
  }
  const wanted = criteriaTerms(criteria);
  if (wanted.length === 0) {
    return {
      relevant: true,
      score: 1,
      matchedTerms: [],
      reason: 'No mission or engagement criteria configured; pre-filter skipped.',
    };
  }

  const haystack = new Set(extractRelevanceTerms(postText));
  const matchedTerms = wanted.filter((term) => haystack.has(term));
  const score = matchedTerms.length / Math.min(wanted.length, 12);

  if (matchedTerms.length === 0) {
    return {
      relevant: false,
      score: 0,
      matchedTerms: [],
      reason: 'No overlap with mission or engagement criteria.',
    };
  }

  return {
    relevant: true,
    score,
    matchedTerms: matchedTerms.slice(0, 8),
    reason: `Matched ${matchedTerms.length} term${matchedTerms.length === 1 ? '' : 's'}.`,
  };
}

/** Keep only posts that pass the cheap relevance gate, preserving order. */
export function prefilterDiscoveryPosts<T extends { text: string }>(
  posts: readonly T[],
  criteria: RelevanceCriteria,
): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let dropped = 0;
  for (const post of posts) {
    if (scoreDiscoveryRelevance(post.text, criteria).relevant) kept.push(post);
    else dropped += 1;
  }
  return { kept, dropped };
}

/** Cap posts after ranking/filter (newest/first wins when already ordered). */
export function capDiscoveryPosts<T>(posts: readonly T[], maxPosts: number): T[] {
  const limit = Math.max(1, Math.min(Math.floor(maxPosts), 100));
  return posts.slice(0, limit);
}
