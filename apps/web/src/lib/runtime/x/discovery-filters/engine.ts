import {
  DEFAULT_MAX_POST_AGE_HOURS,
  type DiscoveryFilterDecision,
  type DiscoveryFilterField,
  type DiscoveryFilterOp,
  type DiscoveryFilterRule,
  type DiscoveryFilters,
  type DiscoveryPostSnapshot,
  FIELD_LABELS,
  OP_LABELS,
} from '@/lib/runtime/x/discovery-filters/types';

function hoursBetween(fromIso: string | null, now: Date): number | null {
  if (!fromIso) return null;
  const then = new Date(fromIso);
  if (Number.isNaN(then.getTime())) return null;
  return (now.getTime() - then.getTime()) / (60 * 60 * 1000);
}

function daysBetween(fromIso: string | null, now: Date): number | null {
  const hours = hoursBetween(fromIso, now);
  return hours === null ? null : hours / 24;
}

function fieldValue(
  snapshot: DiscoveryPostSnapshot,
  field: DiscoveryFilterField,
  now: Date,
): string | number | boolean | null {
  switch (field) {
    case 'post.ageHours':
      return hoursBetween(snapshot.createdAt, now);
    case 'post.lang':
      return snapshot.lang?.toLowerCase() ?? null;
    case 'post.type':
      return snapshot.type;
    case 'post.hasLinks':
      return snapshot.hasLinks;
    case 'post.hasMedia':
      return snapshot.hasMedia;
    case 'post.likes':
      return snapshot.likes;
    case 'post.reposts':
      return snapshot.reposts;
    case 'post.replies':
      return snapshot.replies;
    case 'post.quotes':
      return snapshot.quotes;
    case 'post.impressions':
      return snapshot.impressions;
    case 'post.text':
      return snapshot.text;
    case 'author.followers':
      return snapshot.authorFollowers;
    case 'author.following':
      return snapshot.authorFollowing;
    case 'author.verified':
      return snapshot.authorVerified;
    case 'author.ageDays':
      return daysBetween(snapshot.authorCreatedAt, now);
    case 'author.bio':
      return snapshot.authorBio;
    case 'author.location':
      return snapshot.authorLocation;
    case 'author.name':
      return snapshot.authorName;
    case 'author.handle':
      return snapshot.authorHandle?.toLowerCase().replace(/^@/, '') ?? null;
  }
}

function asStringList(value: DiscoveryFilterRule['value']): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (value === undefined || value === null) return [];
  return [String(value)];
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, '');
}

function compareNumbers(left: number, op: DiscoveryFilterOp, right: number): boolean {
  switch (op) {
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    default:
      return false;
  }
}

function textContains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function evaluateRule(
  snapshot: DiscoveryPostSnapshot,
  rule: DiscoveryFilterRule,
  now: Date,
): { pass: boolean; reason: string } {
  const label = FIELD_LABELS[rule.field];
  const opLabel = OP_LABELS[rule.op];
  const actual = fieldValue(snapshot, rule.field, now);

  if (rule.op === 'is_true' || rule.op === 'is_false') {
    if (typeof actual !== 'boolean') {
      return { pass: false, reason: `${label} is unavailable.` };
    }
    const expected = rule.op === 'is_true';
    const pass = actual === expected;
    return {
      pass,
      reason: pass
        ? `${label} is ${expected ? 'true' : 'false'}.`
        : `${label} failed: expected ${expected ? 'true' : 'false'}.`,
    };
  }

  if (actual === null || actual === undefined) {
    return { pass: false, reason: `${label} is unavailable.` };
  }

  if (rule.op === 'contains' || rule.op === 'not_contains') {
    const needle = String(rule.value ?? '');
    if (!needle) return { pass: false, reason: `${label} rule is missing a value.` };
    const haystack = String(actual);
    const found = textContains(haystack, needle);
    const pass = rule.op === 'contains' ? found : !found;
    return {
      pass,
      reason: pass ? `${label} ${opLabel} “${needle}”.` : `${label} failed ${opLabel} “${needle}”.`,
    };
  }

  if (rule.op === 'matches_any' || rule.op === 'matches_none') {
    const needles = asStringList(rule.value);
    if (!needles.length) return { pass: false, reason: `${label} rule is missing values.` };
    const haystack = String(actual);
    const hit = needles.find((needle) => textContains(haystack, needle));
    const pass = rule.op === 'matches_any' ? Boolean(hit) : !hit;
    return {
      pass,
      reason: pass
        ? hit
          ? `${label} matched “${hit}”.`
          : `${label} matched none of the excluded phrases.`
        : `${label} failed ${opLabel}.`,
    };
  }

  if (rule.op === 'in' || rule.op === 'not_in') {
    let candidates = asStringList(rule.value).map((entry) => entry.toLowerCase());
    let actualText = String(actual).toLowerCase();
    if (rule.field === 'author.handle') {
      candidates = candidates.map(normalizeHandle);
      actualText = normalizeHandle(actualText);
    }
    const included = candidates.includes(actualText);
    const pass = rule.op === 'in' ? included : !included;
    return {
      pass,
      reason: pass
        ? `${label} ${opLabel} the configured list.`
        : `${label} failed ${opLabel} the configured list (was “${actual}”).`,
    };
  }

  if (typeof actual === 'number') {
    const expected = typeof rule.value === 'number' ? rule.value : Number(rule.value);
    if (!Number.isFinite(expected)) {
      return { pass: false, reason: `${label} rule has an invalid number.` };
    }
    const pass = compareNumbers(actual, rule.op, expected);
    return {
      pass,
      reason: pass
        ? `${label} ${opLabel} ${expected} (${formatNumber(actual)}).`
        : `${label} failed ${opLabel} ${expected} (was ${formatNumber(actual)}).`,
    };
  }

  if (rule.op === 'eq' || rule.op === 'neq') {
    const expectedLabel = String(rule.value ?? '');
    let left = String(actual).toLowerCase();
    let right = expectedLabel.toLowerCase();
    if (rule.field === 'author.handle') {
      left = normalizeHandle(left);
      right = normalizeHandle(right);
    }
    const equal = left === right;
    const pass = rule.op === 'eq' ? equal : !equal;
    return {
      pass,
      reason: pass
        ? `${label} ${opLabel} “${expectedLabel}”.`
        : `${label} failed ${opLabel} “${expectedLabel}” (was “${String(actual)}”).`,
    };
  }

  return { pass: false, reason: `${label} does not support ${opLabel}.` };
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function ageLimitReason(hours: number, age: number | null): string {
  if (age === null) return `Post age is unavailable; max age is ${hours}h.`;
  return `Post is ${formatNumber(age)}h old; max age is ${hours}h.`;
}

/**
 * Evaluate discovery filters against a post snapshot.
 * First-class age and recently-engaged checks run before AND-combined rules.
 */
export function evaluateDiscoveryFilters(
  snapshot: DiscoveryPostSnapshot,
  filters: DiscoveryFilters,
  now: Date = new Date(),
): DiscoveryFilterDecision {
  const reasons: string[] = [];
  const maxAge = filters.maxPostAgeHours ?? DEFAULT_MAX_POST_AGE_HOURS;
  const age = hoursBetween(snapshot.createdAt, now);

  if (age === null || age > maxAge) {
    reasons.push(ageLimitReason(maxAge, age));
  }

  if (filters.skipRecentlyEngagedAuthors && snapshot.authorRecentlyEngaged === true) {
    reasons.push(`Author was engaged within the last ${filters.recentlyEngagedWithinHours}h.`);
  }

  for (const rule of filters.rules) {
    const result = evaluateRule(snapshot, rule, now);
    if (!result.pass) reasons.push(result.reason);
  }

  if (reasons.length) return { pass: false, reasons };

  return {
    pass: true,
    reasons: [`Passed discovery filters (max age ${maxAge}h).`],
  };
}

/** True when the post is older than the configured max age. */
export function isPostPastMaxAge(
  createdAt: string | Date | null | undefined,
  maxPostAgeHours: number,
  now: Date = new Date(),
): boolean {
  if (!createdAt) return true;
  const iso = createdAt instanceof Date ? createdAt.toISOString() : createdAt;
  const age = hoursBetween(iso, now);
  return age === null || age > maxPostAgeHours;
}

/** Absolute expiry time for a pending reply given post creation and max age. */
export function postAgeExpiryAt(
  createdAt: string | Date | null | undefined,
  maxPostAgeHours: number,
): Date | null {
  if (!createdAt) return null;
  const then = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(then.getTime())) return null;
  return new Date(then.getTime() + maxPostAgeHours * 60 * 60 * 1000);
}

export function formatFilterSkipReason(reasons: string[]): string {
  return reasons[0] ?? 'Filtered by discovery rules.';
}
