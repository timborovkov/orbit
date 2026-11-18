/**
 * Stable demo markers. All demo-owned rows use these fixed UUIDs (or the
 * DEMO_ACTOR audit string) so reset can delete only seed data.
 */
export const DEMO_ACTOR = 'orbit-demo-seed';

/** Well-known demo agent IDs — never collide with random gen_random_uuid(). */
export const DEMO_AGENTS = {
  john: '00000000-0000-4000-a000-000000000001',
  sarah: '00000000-0000-4000-a000-000000000002',
  maya: '00000000-0000-4000-a000-000000000003',
} as const;

export const DEMO_AGENT_IDS = Object.values(DEMO_AGENTS);

/** Configuration version IDs per agent. */
export const DEMO_CONFIGS = {
  johnV1: '00000000-0000-4000-a100-000000000001',
  johnV2: '00000000-0000-4000-a100-000000000002',
  sarahV1: '00000000-0000-4000-a100-000000000011',
  sarahV2: '00000000-0000-4000-a100-000000000012',
  mayaV1: '00000000-0000-4000-a100-000000000021',
} as const;

export const DEMO_RUNS = {
  johnSucceeded: '00000000-0000-4000-a200-000000000001',
  johnFailed: '00000000-0000-4000-a200-000000000002',
  johnInterrupted: '00000000-0000-4000-a200-000000000003',
  sarahSucceeded: '00000000-0000-4000-a200-000000000011',
  sarahFailed: '00000000-0000-4000-a200-000000000012',
  mayaSucceeded: '00000000-0000-4000-a200-000000000021',
} as const;

export const DEMO_JOBS = {
  johnSucceeded: '00000000-0000-4000-a300-000000000001',
  johnFailed: '00000000-0000-4000-a300-000000000002',
  johnInterrupted: '00000000-0000-4000-a300-000000000003',
  sarahSucceeded: '00000000-0000-4000-a300-000000000011',
  sarahFailed: '00000000-0000-4000-a300-000000000012',
  mayaSucceeded: '00000000-0000-4000-a300-000000000021',
} as const;

export const DEMO_INTENTS = {
  sarahEscalatePending: '00000000-0000-4000-a400-000000000001',
  mayaIntroduceApproved: '00000000-0000-4000-a400-000000000011',
  mayaIntroducePending: '00000000-0000-4000-a400-000000000012',
} as const;

export const DEMO_POLICY = {
  sarahEscalate: '00000000-0000-4000-a500-000000000001',
  mayaIntroduce: '00000000-0000-4000-a500-000000000011',
} as const;

export const DEMO_AUDIT = {
  created: '00000000-0000-4000-a600-000000000001',
  seeded: '00000000-0000-4000-a600-000000000002',
} as const;

export function isDemoAgentId(id: string): boolean {
  return (DEMO_AGENT_IDS as readonly string[]).includes(id);
}
