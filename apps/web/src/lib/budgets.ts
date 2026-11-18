import { z } from 'zod';

/** Defaults from architecture §17. Amounts are USD cents unless noted. */
export const budgetDefaults = {
  dailySpendCents: 500,
  monthlySpendCents: 5000,
  dailyRequests: 200,
  monthlyRequests: 5000,
  dailyOutboundActions: 50,
  monthlyOutboundActions: 1000,
  maxConcurrentRuns: 1,
  maxToolStepsPerRun: 10,
  runDeadlineSeconds: 300,
} as const;

export const budgetsSchema = z.object({
  dailySpendCents: z.number().int().min(0).max(1_000_000).nullable(),
  monthlySpendCents: z.number().int().min(0).max(10_000_000).nullable(),
  dailyRequests: z.number().int().min(0).max(1_000_000),
  monthlyRequests: z.number().int().min(0).max(10_000_000),
  dailyOutboundActions: z.number().int().min(0).max(1_000_000),
  monthlyOutboundActions: z.number().int().min(0).max(10_000_000),
  maxConcurrentRuns: z.number().int().min(1).max(50),
  maxToolStepsPerRun: z.number().int().min(1).max(100),
  runDeadlineSeconds: z.number().int().min(30).max(3600),
});

export type AgentBudgets = z.infer<typeof budgetsSchema>;

/** Period-specific accessible name for spend-cap switches (visible text stays "No cap"). */
export function budgetNoCapAriaLabel(fieldKey: 'dailySpendCents' | 'monthlySpendCents'): string {
  return fieldKey === 'dailySpendCents' ? 'No cap for daily spend' : 'No cap for monthly spend';
}

export const budgetFields = [
  {
    key: 'dailySpendCents',
    label: 'Daily OpenRouter spend cap (USD cents)',
    hint: 'Combine actual costs and reserved calls per UTC day.',
  },
  {
    key: 'monthlySpendCents',
    label: 'Monthly OpenRouter spend cap (USD cents)',
    hint: 'Combine actual costs and reserved calls per UTC month.',
  },
  {
    key: 'dailyRequests',
    label: 'Daily request quota',
    hint: 'Maximum evaluator and main-model calls per UTC day.',
  },
  {
    key: 'monthlyRequests',
    label: 'Monthly request quota',
    hint: 'Maximum evaluator and main-model calls per UTC month.',
  },
  {
    key: 'dailyOutboundActions',
    label: 'Daily outbound-action cap',
    hint: 'Maximum policy-allowed external writes per UTC day.',
  },
  {
    key: 'monthlyOutboundActions',
    label: 'Monthly outbound-action cap',
    hint: 'Maximum policy-allowed external writes per UTC month.',
  },
  {
    key: 'maxConcurrentRuns',
    label: 'Concurrency limit',
    hint: 'Queued plus running jobs for this agent at once.',
  },
  {
    key: 'maxToolStepsPerRun',
    label: 'Max tool steps per run',
    hint: 'Hard stop after this many tool invocations in one run.',
  },
  {
    key: 'runDeadlineSeconds',
    label: 'Run deadline (seconds)',
    hint: 'Abort a run that exceeds this wall-clock deadline.',
  },
] as const satisfies readonly {
  key: keyof AgentBudgets;
  label: string;
  hint: string;
}[];

export function parseBudgets(value: unknown): AgentBudgets {
  return budgetsSchema.parse({ ...budgetDefaults, ...(value as object) });
}

export function hasSpendCap(budgets: AgentBudgets) {
  return budgets.dailySpendCents !== null || budgets.monthlySpendCents !== null;
}

export interface BudgetSnapshot {
  budgets: AgentBudgets;
  day: { spendMicros: bigint; requests: number; outboundActions: number };
  month: { spendMicros: bigint; requests: number; outboundActions: number };
  activeRuns: number;
}

export type BudgetViolation =
  | 'unknown-price'
  | 'daily-spend'
  | 'monthly-spend'
  | 'daily-spend-reservation'
  | 'monthly-spend-reservation'
  | 'daily-requests'
  | 'monthly-requests'
  | 'daily-outbound'
  | 'monthly-outbound'
  | 'concurrency'
  | 'tool-steps'
  | 'run-deadline';

export function checkRequestBudgets(
  snapshot: BudgetSnapshot,
  reserveMicros = BigInt(0),
  reserveRequests = 1,
  options?: {
    /**
     * When false, skip spend checks. Used for in-run tools (`load_skill`, MCP) that
     * add no inference spend — the stage reservation may already fill the cap and is
     * still counted in spendMicros until settlement.
     */
    checkSpend?: boolean;
  },
): BudgetViolation | null {
  const { budgets, day, month, activeRuns } = snapshot;
  if (activeRuns >= budgets.maxConcurrentRuns) return 'concurrency';
  if (day.requests + reserveRequests > budgets.dailyRequests) return 'daily-requests';
  if (month.requests + reserveRequests > budgets.monthlyRequests) return 'monthly-requests';
  if (options?.checkSpend === false) return null;
  for (const [reached, reservation, used, cap] of [
    ['daily-spend', 'daily-spend-reservation', day.spendMicros, budgets.dailySpendCents],
    ['monthly-spend', 'monthly-spend-reservation', month.spendMicros, budgets.monthlySpendCents],
  ] as const) {
    if (cap === null) continue;
    const limit = BigInt(cap) * BigInt(10_000);
    if (used >= limit) return reached;
    if (used + reserveMicros > limit) return reservation;
  }
  return null;
}

export function checkOutboundBudgets(snapshot: BudgetSnapshot): BudgetViolation | null {
  const { budgets, day, month } = snapshot;
  if (day.outboundActions >= budgets.dailyOutboundActions) return 'daily-outbound';
  if (month.outboundActions >= budgets.monthlyOutboundActions) return 'monthly-outbound';
  return null;
}

/** True when completed steps have exceeded the allowed count (exactly max is still permitted). */
export function checkToolStepLimit(steps: number, budgets: AgentBudgets): BudgetViolation | null {
  return steps > budgets.maxToolStepsPerRun ? 'tool-steps' : null;
}

export function checkRunDeadline(
  startedAt: Date,
  now: Date,
  budgets: AgentBudgets,
): BudgetViolation | null {
  const elapsed = (now.getTime() - startedAt.getTime()) / 1000;
  return elapsed >= budgets.runDeadlineSeconds ? 'run-deadline' : null;
}

export function budgetViolationMessage(violation: BudgetViolation): string {
  switch (violation) {
    case 'unknown-price':
      return 'OpenRouter pricing could not be verified for this model. Choose a priced model or turn off both spend caps.';
    case 'daily-spend':
      return 'Daily OpenRouter spend cap reached. Work was deferred.';
    case 'monthly-spend':
      return 'Monthly OpenRouter spend cap reached. Work was deferred.';
    case 'daily-spend-reservation':
      return 'Daily OpenRouter spend reservation could not fit under the cap. Work was deferred.';
    case 'monthly-spend-reservation':
      return 'Monthly OpenRouter spend reservation could not fit under the cap. Work was deferred.';
    case 'daily-requests':
      return 'Daily request quota reached. Work was deferred.';
    case 'monthly-requests':
      return 'Monthly request quota reached. Work was deferred.';
    case 'daily-outbound':
      return 'Daily outbound-action cap reached. Action denied.';
    case 'monthly-outbound':
      return 'Monthly outbound-action cap reached. Action denied.';
    case 'concurrency':
      return 'Agent concurrency limit reached. Work was deferred.';
    case 'tool-steps':
      return 'Maximum tool steps for this run reached.';
    case 'run-deadline':
      return 'Run deadline exceeded.';
  }
}

/** Trusted internal budget/cancellation errors — never built from provider text. */
export class BudgetError extends Error {
  readonly kind: BudgetViolation | 'cancelled';

  constructor(kind: BudgetViolation | 'cancelled') {
    super(
      kind === 'cancelled'
        ? 'Run deadline reached or the worker cancelled this simulation.'
        : budgetViolationMessage(kind),
    );
    this.name = 'BudgetError';
    this.kind = kind;
  }
}

export function isBudgetError(error: unknown): error is BudgetError {
  return error instanceof BudgetError;
}

const trustedBudgetMessages = new Set<string>([
  ...(
    [
      'unknown-price',
      'daily-spend',
      'monthly-spend',
      'daily-spend-reservation',
      'monthly-spend-reservation',
      'daily-requests',
      'monthly-requests',
      'daily-outbound',
      'monthly-outbound',
      'concurrency',
      'tool-steps',
      'run-deadline',
    ] as const satisfies readonly BudgetViolation[]
  ).map((kind) => budgetViolationMessage(kind)),
  new BudgetError('cancelled').message,
]);

/** Exact allowlist of messages we may surface from internal budget/cancel paths. */
export function isTrustedBudgetMessage(message: string): boolean {
  return trustedBudgetMessages.has(message);
}
