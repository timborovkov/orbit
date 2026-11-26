import { z } from 'zod';

import {
  DEFAULT_LANGUAGE_RULE,
  DEFAULT_MAX_POST_AGE_HOURS,
  DEFAULT_RECENTLY_ENGAGED_WITHIN_HOURS,
  DISCOVERY_FILTER_FIELDS,
  DISCOVERY_FILTER_OPS,
  DISCOVERY_FILTER_VERSION,
  type DiscoveryFilterField,
  type DiscoveryFilterOp,
  type DiscoveryFilterRule,
  type DiscoveryFilters,
  FIELD_OPERATORS,
} from '@/lib/runtime/x/discovery-filters/types';

const MAX_LIST_ENTRY_LENGTH = 200;

const filterValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string().trim().min(1).max(MAX_LIST_ENTRY_LENGTH)).max(50),
]);

const discoveryFilterRuleSchema = z
  .object({
    field: z.enum(DISCOVERY_FILTER_FIELDS),
    op: z.enum(DISCOVERY_FILTER_OPS),
    value: filterValue.optional(),
  })
  .superRefine((rule, ctx) => {
    const allowed = FIELD_OPERATORS[rule.field];
    if (!allowed.includes(rule.op)) {
      ctx.addIssue({
        code: 'custom',
        message: `Operator ${rule.op} is not valid for ${rule.field}.`,
        path: ['op'],
      });
    }
    if (rule.op === 'is_true' || rule.op === 'is_false') return;
    if (rule.value === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A value is required for this operator.',
        path: ['value'],
      });
    }
  });

export const discoveryFiltersSchema = z.object({
  version: z.literal(DISCOVERY_FILTER_VERSION).default(DISCOVERY_FILTER_VERSION),
  maxPostAgeHours: z.number().min(0.25).max(168).default(DEFAULT_MAX_POST_AGE_HOURS),
  skipRecentlyEngagedAuthors: z.boolean().default(false),
  recentlyEngagedWithinHours: z
    .number()
    .int()
    .min(1)
    .max(720)
    .default(DEFAULT_RECENTLY_ENGAGED_WITHIN_HOURS),
  rules: z.array(discoveryFilterRuleSchema).max(50).default([]),
});

export const defaultDiscoveryFilters = (): DiscoveryFilters => ({
  version: DISCOVERY_FILTER_VERSION,
  maxPostAgeHours: DEFAULT_MAX_POST_AGE_HOURS,
  skipRecentlyEngagedAuthors: false,
  recentlyEngagedWithinHours: DEFAULT_RECENTLY_ENGAGED_WITHIN_HOURS,
  rules: [{ ...DEFAULT_LANGUAGE_RULE }],
});

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeRule(raw: unknown): DiscoveryFilterRule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const field = input.field;
  const op = input.op;
  if (typeof field !== 'string' || typeof op !== 'string') return null;
  if (!(DISCOVERY_FILTER_FIELDS as readonly string[]).includes(field)) return null;
  if (!(DISCOVERY_FILTER_OPS as readonly string[]).includes(op)) return null;
  const allowed = FIELD_OPERATORS[field as DiscoveryFilterField];
  if (!allowed.includes(op as DiscoveryFilterOp)) return null;

  let value: DiscoveryFilterRule['value'];
  if (op === 'is_true' || op === 'is_false') {
    value = undefined;
  } else if (Array.isArray(input.value)) {
    value = input.value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim().slice(0, MAX_LIST_ENTRY_LENGTH))
      .filter(Boolean)
      .slice(0, 50);
  } else if (
    typeof input.value === 'string' ||
    typeof input.value === 'number' ||
    typeof input.value === 'boolean'
  ) {
    value = input.value;
  } else {
    return null;
  }

  return { field: field as DiscoveryFilterField, op: op as DiscoveryFilterOp, value };
}

/**
 * Normalize legacy / partial filter objects into the current versioned shape.
 * Existing agent configs without filters receive the 2-hour max age default.
 */
export function normalizeDiscoveryFilters(raw: unknown): DiscoveryFilters {
  const defaults = defaultDiscoveryFilters();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const input = raw as Record<string, unknown>;

  const maxPostAgeHours =
    asFiniteNumber(input.maxPostAgeHours) ??
    asFiniteNumber(input.max_post_age_hours) ??
    defaults.maxPostAgeHours;

  const recentlyEngagedWithinHours =
    asFiniteNumber(input.recentlyEngagedWithinHours) ??
    asFiniteNumber(input.recently_engaged_within_hours) ??
    defaults.recentlyEngagedWithinHours;

  // Absent `rules` gets the default English gate (same as missing maxPostAgeHours).
  // An explicit empty array means the admin cleared rules and must be preserved.
  const rules = Object.prototype.hasOwnProperty.call(input, 'rules')
    ? Array.isArray(input.rules)
      ? input.rules.map(normalizeRule).filter((rule): rule is DiscoveryFilterRule => rule !== null)
      : defaults.rules
    : defaults.rules;

  const parsed = discoveryFiltersSchema.safeParse({
    version: DISCOVERY_FILTER_VERSION,
    maxPostAgeHours: Math.min(168, Math.max(0.25, maxPostAgeHours)),
    skipRecentlyEngagedAuthors:
      typeof input.skipRecentlyEngagedAuthors === 'boolean'
        ? input.skipRecentlyEngagedAuthors
        : defaults.skipRecentlyEngagedAuthors,
    recentlyEngagedWithinHours: Math.min(720, Math.max(1, Math.round(recentlyEngagedWithinHours))),
    rules: rules.slice(0, 50),
  });

  return parsed.success ? parsed.data : defaults;
}
