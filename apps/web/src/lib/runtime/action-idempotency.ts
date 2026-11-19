import { createHash } from 'node:crypto';

/**
 * Stable key for action intents. Must match the parts execute.ts passes into
 * authorizeAction so seeded reviews are found on resume.
 */
export function actionIdempotencyKey(parts: {
  runId: string;
  stage: 'evaluator' | 'main';
  actionType: string;
  index: number;
  reason: string;
}): string {
  return createHash('sha256')
    .update(
      [parts.runId, parts.stage, parts.actionType, String(parts.index), parts.reason].join(':'),
    )
    .digest('hex');
}
