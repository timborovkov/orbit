const blockedPolicy = new Set(['deny', 'needs-approval', 'suppressed', 'denied']);
const policyDecisions = new Set(['allow', 'deny', 'needs-approval', 'suppressed', 'denied']);
const microsPerDollar = 1_000_000;
const maxCostUsd = Number.MAX_SAFE_INTEGER / microsPerDollar;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Map trusted Orbit tags into Langfuse observation/trace metadata attributes. */
export function langfuseMetadataAttributes(
  tags: Record<string, string | number | boolean>,
  scope: 'observation' | 'trace' | 'both' = 'observation',
): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    const encoded = JSON.stringify(value);
    if (scope !== 'trace') attributes[`langfuse.observation.metadata.${key}`] = encoded;
    if (scope !== 'observation') attributes[`langfuse.trace.metadata.${key}`] = encoded;
  }
  return attributes;
}

/**
 * Langfuse maps generation cost from `gen_ai.usage.cost` (as `total`) or
 * `langfuse.observation.cost_details` JSON. These are generation-only.
 */
export function generationCostAttributes(
  costUsd: number,
): Record<string, string | number> | undefined {
  if (!Number.isFinite(costUsd) || costUsd < 0 || costUsd > maxCostUsd) return;
  return {
    'gen_ai.usage.cost': costUsd,
    'langfuse.observation.cost_details': JSON.stringify({ total: costUsd }),
  };
}

export function openRouterCostUsd(source: unknown): number | undefined {
  const metadata = providerMetadataFrom(source);
  const openrouter = isPlainObject(metadata) ? metadata.openrouter : undefined;
  const usage = isPlainObject(openrouter) ? openrouter.usage : undefined;
  const cost = isPlainObject(usage) ? usage.cost : undefined;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || cost > maxCostUsd) {
    return;
  }
  return cost;
}

function providerMetadataFrom(source: unknown): unknown {
  if (!isPlainObject(source)) return source;
  if (source.providerMetadata !== undefined) return source.providerMetadata;
  if (isPlainObject(source.response) && source.response.providerMetadata !== undefined) {
    return source.response.providerMetadata;
  }
  return source;
}

export function applyOpenRouterCostToSpan(
  span: { setAttribute(key: string, value: string | number): void } | undefined,
  source: unknown,
) {
  const cost = openRouterCostUsd(source);
  if (cost === undefined || !span) return;
  const attributes = generationCostAttributes(cost);
  if (!attributes) return;
  for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
}

export function langfuseBlockedStatus(
  attributes: Record<string, string | number | boolean | undefined>,
  result?: unknown,
): { level: 'WARNING' | 'ERROR'; message: string } | undefined {
  const policy = policyDecisionOf(attributes.policy_decision) ?? policyDecisionOf(result);
  if (policy && blockedPolicy.has(policy)) {
    return { level: 'WARNING', message: `policy:${policy}` };
  }
  const budget =
    typeof attributes.budget_violation === 'string' ? attributes.budget_violation : undefined;
  if (budget) return { level: 'ERROR', message: `budget:${budget}` };
  const outcome = typeof attributes.outcome === 'string' ? attributes.outcome : undefined;
  if (outcome === 'paid-step-burn' || outcome === 'force-dead-letter') {
    return { level: 'ERROR', message: outcome };
  }
}

function policyDecisionOf(value: unknown): string | undefined {
  if (typeof value === 'string') return policyDecisions.has(value) ? value : undefined;
  if (!isPlainObject(value) || typeof value.decision !== 'string') return;
  return policyDecisions.has(value.decision) ? value.decision : undefined;
}
