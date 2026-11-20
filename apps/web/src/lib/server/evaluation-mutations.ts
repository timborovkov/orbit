import 'server-only';

import { saveEvaluationCase, startEvaluationComparison } from '@/lib/runtime/evaluation';
import type { EvaluationCaseSource } from '@/lib/schema';

export async function createEvaluationCaseFromSource(
  actor: string,
  input: {
    agentId: string;
    title: string;
    sourceKind: EvaluationCaseSource;
    sourceRunId?: string | null;
    sourceEmailMessageId?: string | null;
    caseInput: string;
    recipients?: string[];
  },
) {
  return saveEvaluationCase({ actor, ...input });
}

export async function enqueueEvaluationComparison(
  actor: string,
  input: {
    agentId: string;
    caseId: string;
    leftConfigurationId: string;
    rightConfigurationId: string;
  },
) {
  return startEvaluationComparison({ actor, ...input });
}
