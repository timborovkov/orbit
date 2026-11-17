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
  dailySpendCents: z.number().int().min(0).max(1_000_000),
  monthlySpendCents: z.number().int().min(0).max(10_000_000),
  dailyRequests: z.number().int().min(0).max(1_000_000),
  monthlyRequests: z.number().int().min(0).max(10_000_000),
  dailyOutboundActions: z.number().int().min(0).max(1_000_000),
  monthlyOutboundActions: z.number().int().min(0).max(10_000_000),
  maxConcurrentRuns: z.number().int().min(1).max(50),
  maxToolStepsPerRun: z.number().int().min(1).max(100),
  runDeadlineSeconds: z.number().int().min(30).max(3600),
});

export type AgentBudgets = z.infer<typeof budgetsSchema>;

export const budgetFields = [
  {
    key: 'dailySpendCents',
    label: 'Daily OpenRouter spend cap (USD cents)',
    hint: 'Reject new model calls once estimated spend reaches this cap.',
  },
  {
    key: 'monthlySpendCents',
    label: 'Monthly OpenRouter spend cap (USD cents)',
    hint: 'Reject new model calls once estimated monthly spend reaches this cap.',
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
] as const satisfies ReadonlyArray<{
  key: keyof AgentBudgets;
  label: string;
  hint: string;
}>;

export function parseBudgets(value: unknown): AgentBudgets {
  return budgetsSchema.parse({ ...budgetDefaults, ...(value as object) });
}

/**
 * OpenRouter does not always return monetary cost. When pricing is unavailable we
 * record token counts only and treat spend as 0 for budget enforcement, while still
 * applying request, concurrency, step and deadline caps. Documented in architecture.md.
 */
export function estimateSpendMicros(inputTokens: number, outputTokens: number, microsPerToken = 0) {
  if (microsPerToken <= 0) return 0;
  return BigInt(Math.max(0, inputTokens) + Math.max(0, outputTokens)) * BigInt(microsPerToken);
}

export type BudgetSnapshot = {
  budgets: AgentBudgets;
  day: { spendMicros: bigint; requests: number; outboundActions: number };
  month: { spendMicros: bigint; requests: number; outboundActions: number };
  activeRuns: number;
};

export type BudgetViolation =
  | 'daily-spend'
  | 'monthly-spend'
  | 'daily-requests'
  | 'monthly-requests'
  | 'daily-outbound'
  | 'monthly-outbound'
  | 'concurrency'
  | 'tool-steps'
  | 'run-deadline';

export function checkRequestBudgets(snapshot: BudgetSnapshot): BudgetViolation | null {
  const { budgets, day, month, activeRuns } = snapshot;
  if (activeRuns >= budgets.maxConcurrentRuns) return 'concurrency';
  if (day.requests >= budgets.dailyRequests) return 'daily-requests';
  if (month.requests >= budgets.monthlyRequests) return 'monthly-requests';
  if (day.spendMicros >= BigInt(budgets.dailySpendCents) * 10_000n) return 'daily-spend';
  if (month.spendMicros >= BigInt(budgets.monthlySpendCents) * 10_000n) return 'monthly-spend';
  return null;
}

export function checkOutboundBudgets(snapshot: BudgetSnapshot): BudgetViolation | null {
  const { budgets, day, month } = snapshot;
  if (day.outboundActions >= budgets.dailyOutboundActions) return 'daily-outbound';
  if (month.outboundActions >= budgets.monthlyOutboundActions) return 'monthly-outbound';
  return null;
}

export function checkToolStepLimit(steps: number, budgets: AgentBudgets): BudgetViolation | null {
  return steps >= budgets.maxToolStepsPerRun ? 'tool-steps' : null;
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
    case 'daily-spend':
      return 'Daily OpenRouter spend cap reached. Work was deferred.';
    case 'monthly-spend':
      return 'Monthly OpenRouter spend cap reached. Work was deferred.';
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
