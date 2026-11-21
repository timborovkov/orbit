export const approvalReviewLimit = 50;

/** Merge agent and global approval tool lists (order-stable unique). */
export function mergeApprovalTools(
  agentTools: string[] | null | undefined,
  globalTools: string[] | null | undefined,
) {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const tool of [...(agentTools ?? []), ...(globalTools ?? [])]) {
    if (!tool || seen.has(tool)) continue;
    seen.add(tool);
    merged.push(tool);
  }
  return merged;
}

/**
 * True when this write action requires administrator approval under configured
 * approvalTools or the spend threshold. Introduce/escalate are opt-in via
 * approvalTools like other actions. Outbound email replies always require
 * approval through its adapter. Preliminary (evaluator) proposals skip this.
 */
export function actionNeedsApproval(input: {
  actionType: string;
  preliminary?: boolean;
  requiredByAdapter?: boolean;
  approvalTools: string[];
  approvalSpendCents: number | null;
  /** Day spend already recorded for the agent, in microdollars. */
  daySpendMicros: bigint;
}): boolean {
  if (input.preliminary) return false;
  if (input.requiredByAdapter) return true;
  if (input.approvalTools.includes(input.actionType)) return true;
  if (
    input.approvalSpendCents !== null &&
    input.daySpendMicros >= BigInt(input.approvalSpendCents) * BigInt(10_000)
  ) {
    return true;
  }
  return false;
}
