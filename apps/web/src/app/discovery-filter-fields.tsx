'use client';

import { useMemo, useState } from 'react';

import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  DEFAULT_MAX_POST_AGE_HOURS,
  DEFAULT_RECENTLY_ENGAGED_WITHIN_HOURS,
  DISCOVERY_FILTER_FIELDS,
  DISCOVERY_FILTER_VERSION,
  type DiscoveryFilterField,
  type DiscoveryFilterOp,
  type DiscoveryFilterRule,
  type DiscoveryFilters,
  FIELD_LABELS,
  FIELD_OPERATORS,
  OP_LABELS,
} from '@/lib/runtime/x/discovery-filters';

type RuleRow = DiscoveryFilterRule & { id: string };

function newRule(partial?: Partial<DiscoveryFilterRule>): RuleRow {
  const field = partial?.field ?? 'post.lang';
  const ops = FIELD_OPERATORS[field];
  const fallbackOp = ops[0] ?? 'eq';
  return {
    id: crypto.randomUUID(),
    field,
    op: partial?.op && ops.includes(partial.op) ? partial.op : fallbackOp,
    value: partial?.value ?? '',
  };
}

function valueNeedsList(op: DiscoveryFilterOp): boolean {
  return op === 'in' || op === 'not_in' || op === 'matches_any' || op === 'matches_none';
}

function valueNeedsNone(op: DiscoveryFilterOp): boolean {
  return op === 'is_true' || op === 'is_false';
}

function serializeFilters(filters: DiscoveryFilters): string {
  return JSON.stringify({
    version: DISCOVERY_FILTER_VERSION,
    maxPostAgeHours: filters.maxPostAgeHours,
    skipRecentlyEngagedAuthors: filters.skipRecentlyEngagedAuthors,
    recentlyEngagedWithinHours: filters.recentlyEngagedWithinHours,
    rules: filters.rules.map(({ field, op, value }) => ({ field, op, value })),
  });
}

export function DiscoveryFilterFields({
  prefix,
  initial,
}: {
  prefix: string;
  initial: DiscoveryFilters;
}) {
  const [maxPostAgeHours, setMaxPostAgeHours] = useState(initial.maxPostAgeHours);
  const [skipRecentlyEngaged, setSkipRecentlyEngaged] = useState(
    initial.skipRecentlyEngagedAuthors,
  );
  const [recentWindow, setRecentWindow] = useState(initial.recentlyEngagedWithinHours);
  const [rules, setRules] = useState<RuleRow[]>(() => initial.rules.map((rule) => newRule(rule)));

  const payload = useMemo(
    () =>
      serializeFilters({
        version: DISCOVERY_FILTER_VERSION,
        maxPostAgeHours,
        skipRecentlyEngagedAuthors: skipRecentlyEngaged,
        recentlyEngagedWithinHours: recentWindow,
        rules: rules.map(({ field, op, value }) => {
          if (valueNeedsNone(op)) return { field, op };
          if (valueNeedsList(op)) {
            const list = Array.isArray(value)
              ? value
              : String(value ?? '')
                  .split(/[\n,]/)
                  .map((entry) => entry.trim())
                  .filter(Boolean);
            return { field, op, value: list };
          }
          if (
            field.startsWith('post.') &&
            ['likes', 'reposts', 'replies', 'quotes', 'impressions', 'ageHours'].some((key) =>
              field.endsWith(key),
            )
          ) {
            const numeric = typeof value === 'number' ? value : Number(value);
            return { field, op, value: Number.isFinite(numeric) ? numeric : 0 };
          }
          if (
            field === 'author.followers' ||
            field === 'author.following' ||
            field === 'author.ageDays'
          ) {
            const numeric = typeof value === 'number' ? value : Number(value);
            return { field, op, value: Number.isFinite(numeric) ? numeric : 0 };
          }
          return { field, op, value: value ?? '' };
        }),
      }),
    [maxPostAgeHours, skipRecentlyEngaged, recentWindow, rules],
  );

  return (
    <div className="discovery-filters" role="group" aria-label="Discovery filters">
      <input type="hidden" name="xDiscoveryFilters" value={payload} />

      <div className="discovery-filter-basics">
        <Field>
          <FieldLabel htmlFor={`${prefix}-max-post-age`}>Max post age (hours)</FieldLabel>
          <Input
            id={`${prefix}-max-post-age`}
            type="number"
            min={0.25}
            max={168}
            step={0.25}
            value={maxPostAgeHours}
            onChange={(event) => {
              const next = Number(event.target.value);
              setMaxPostAgeHours(Number.isFinite(next) ? next : DEFAULT_MAX_POST_AGE_HOURS);
            }}
            className="max-w-[140px]"
          />
          <FieldDescription>
            Replies to older posts are skipped and cannot be approved.
          </FieldDescription>
        </Field>

        <Field orientation="horizontal" className="items-center justify-between gap-4">
          <div className="space-y-1">
            <FieldLabel htmlFor={`${prefix}-skip-engaged`}>
              Skip recently engaged authors
            </FieldLabel>
            <FieldDescription>
              Ignore authors this agent already contacted within the window.
            </FieldDescription>
          </div>
          <Switch
            id={`${prefix}-skip-engaged`}
            checked={skipRecentlyEngaged}
            onCheckedChange={setSkipRecentlyEngaged}
          />
        </Field>

        {skipRecentlyEngaged && (
          <Field>
            <FieldLabel htmlFor={`${prefix}-engaged-window`}>Engagement window (hours)</FieldLabel>
            <Input
              id={`${prefix}-engaged-window`}
              type="number"
              min={1}
              max={720}
              value={recentWindow}
              onChange={(event) => {
                const next = Number(event.target.value);
                setRecentWindow(
                  Number.isFinite(next) ? next : DEFAULT_RECENTLY_ENGAGED_WITHIN_HOURS,
                );
              }}
              className="max-w-[140px]"
            />
          </Field>
        )}
      </div>

      <div className="discovery-filter-rules">
        <div className="discovery-filter-rules-heading">
          <h3>Rules</h3>
          <p className="muted">All rules must pass (AND).</p>
        </div>

        <ul className="discovery-filter-rule-list" aria-label="Filter rules">
          {rules.map((row, index) => {
            const ops = FIELD_OPERATORS[row.field];
            const listValue = valueNeedsList(row.op);
            const noValue = valueNeedsNone(row.op);
            return (
              <li key={row.id} className="discovery-filter-rule">
                <Field className="discovery-filter-field">
                  <FieldLabel
                    htmlFor={`${prefix}-rule-field-${row.id}`}
                    className={index > 0 ? 'sr-only' : undefined}
                  >
                    Field
                  </FieldLabel>
                  <select
                    id={`${prefix}-rule-field-${row.id}`}
                    aria-label={`Rule ${index + 1} field`}
                    value={row.field}
                    onChange={(event) => {
                      const field = event.target.value as DiscoveryFilterField;
                      const nextOps = FIELD_OPERATORS[field];
                      const nextOpSet = new Set<DiscoveryFilterOp>(nextOps);
                      const fallbackOp = nextOps[0] ?? 'eq';
                      setRules((current) =>
                        current.map((entry) =>
                          entry.id === row.id
                            ? {
                                ...entry,
                                field,
                                op: nextOpSet.has(entry.op) ? entry.op : fallbackOp,
                                value: '',
                              }
                            : entry,
                        ),
                      );
                    }}
                  >
                    {DISCOVERY_FILTER_FIELDS.map((field) => (
                      <option key={field} value={field}>
                        {FIELD_LABELS[field]}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field className="discovery-filter-op">
                  <FieldLabel
                    htmlFor={`${prefix}-rule-op-${row.id}`}
                    className={index > 0 ? 'sr-only' : undefined}
                  >
                    Operator
                  </FieldLabel>
                  <select
                    id={`${prefix}-rule-op-${row.id}`}
                    aria-label={`Rule ${index + 1} operator`}
                    value={row.op}
                    onChange={(event) => {
                      const op = event.target.value as DiscoveryFilterOp;
                      setRules((current) =>
                        current.map((entry) =>
                          entry.id === row.id
                            ? { ...entry, op, value: valueNeedsNone(op) ? undefined : '' }
                            : entry,
                        ),
                      );
                    }}
                  >
                    {ops.map((op) => (
                      <option key={op} value={op}>
                        {OP_LABELS[op]}
                      </option>
                    ))}
                  </select>
                </Field>

                {!noValue && (
                  <Field className="discovery-filter-value min-w-0 flex-1">
                    <FieldLabel
                      htmlFor={`${prefix}-rule-value-${row.id}`}
                      className={index > 0 ? 'sr-only' : undefined}
                    >
                      Value
                    </FieldLabel>
                    <Input
                      id={`${prefix}-rule-value-${row.id}`}
                      value={
                        Array.isArray(row.value)
                          ? row.value.join(', ')
                          : row.value === undefined || row.value === null
                            ? ''
                            : String(row.value)
                      }
                      placeholder={listValue ? 'comma-separated values' : 'value'}
                      onChange={(event) => {
                        const value = event.target.value;
                        setRules((current) =>
                          current.map((entry) =>
                            entry.id === row.id ? { ...entry, value } : entry,
                          ),
                        );
                      }}
                    />
                  </Field>
                )}

                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove rule ${index + 1}`}
                  onClick={() => {
                    setRules((current) => current.filter((entry) => entry.id !== row.id));
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>

        {rules.length < 50 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setRules((current) => [...current, newRule()]);
            }}
          >
            <Plus size={14} aria-hidden="true" />
            Add rule
          </Button>
        )}
      </div>
    </div>
  );
}
