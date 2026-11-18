import { budgetDefaults, type AgentBudgets } from '@/lib/budgets';
import type { LifecycleState } from '@/lib/lifecycle';
import type { AgentConfig } from '@/lib/runtime/config';
import type { SimulationResult } from '@/lib/runtime/simulation';
import { demoTime, utcDay, utcMonthStart } from '@/lib/seed/clock';
import { DEMO_AGENTS, DEMO_CONFIGS, DEMO_JOBS, DEMO_RUNS } from '@/lib/seed/ids';

export interface DemoAgentSpec {
  id: string;
  key: 'john' | 'sarah' | 'maya';
  name: string;
  mission: string;
  templateId: 'sales' | 'support' | 'superconnector';
  lifecycle: LifecycleState;
  budgets: AgentBudgets;
  approvalTools: string[];
  enabledTools: string[];
  /** Fake OpenRouter key plaintext when encryption is configured; omitted otherwise. */
  fakeOpenRouterKey?: string;
}

export interface DemoConfigSpec {
  id: string;
  agentId: string;
  version: number;
  config: AgentConfig;
  createdOffsetMs: number;
}

export interface DemoRunSpec {
  id: string;
  jobId: string;
  agentId: string;
  configurationId: string;
  input: string;
  recipients: string[];
  status: 'completed' | 'failed' | 'interrupted';
  result: SimulationResult;
  createdOffsetMs: number;
  finishedOffsetMs: number | null;
  expiresOffsetMs: number;
  deferReason: string | null;
}

function baseConfig(
  name: string,
  template: Omit<AgentConfig, 'name' | 'mission'> & { mission: string },
): AgentConfig {
  return { name, ...template };
}

const johnPersonality =
  'Warm, concise and consultative. Speaks plainly about The Timeline without hype.';
const sarahPersonality = 'Patient, empathetic and precise. Explains steps clearly.';
const mayaPersonality = 'Thoughtful, curious and generous. Focuses on mutual benefit.';

export function demoAgents(): DemoAgentSpec[] {
  return [
    {
      id: DEMO_AGENTS.john,
      key: 'john',
      name: 'John',
      mission:
        'Represent The Timeline, discover potential customers, and arrange demos with a human.',
      templateId: 'sales',
      lifecycle: 'shadow',
      budgets: {
        ...budgetDefaults,
        dailySpendCents: 800,
        monthlySpendCents: 8000,
      },
      approvalTools: [],
      enabledTools: [],
      fakeOpenRouterKey: 'sk-or-demo-john-not-a-real-key',
    },
    {
      id: DEMO_AGENTS.sarah,
      key: 'sarah',
      name: 'Sarah',
      mission: 'Answer product questions, troubleshoot safely, and escalate when needed.',
      templateId: 'support',
      lifecycle: 'live',
      budgets: { ...budgetDefaults },
      approvalTools: ['escalate'],
      enabledTools: [],
    },
    {
      id: DEMO_AGENTS.maya,
      key: 'maya',
      name: 'Maya',
      mission:
        "Learn consenting participants' needs and offers, then arrange introductions with double opt-in.",
      templateId: 'superconnector',
      lifecycle: 'paused',
      budgets: {
        ...budgetDefaults,
        dailyOutboundActions: 20,
        monthlyOutboundActions: 400,
      },
      approvalTools: ['introduce'],
      enabledTools: [],
    },
  ];
}

export function demoConfigurations(): DemoConfigSpec[] {
  const johnBase = {
    role: 'Sales representative',
    personality: johnPersonality,
    mission:
      'Represent The Timeline, discover potential customers, and arrange demos with a human.',
    instructions:
      'Ask useful discovery questions. Offer a demo only when interest is expressed. Never invent features, prices or customer claims.',
    engagementCriteria:
      'Engage with explicit buying intent, relevant business problems and product questions.',
    mainModel: 'deepseek/deepseek-v4.1-flash-1017',
    evaluatorModel: 'deepseek/deepseek-v4.1-flash-1017',
  };
  const sarahBase = {
    role: 'Customer support specialist',
    personality: sarahPersonality,
    mission: 'Answer product questions, troubleshoot safely, and escalate when needed.',
    instructions:
      'Clarify symptoms, suggest safe troubleshooting and acknowledge uncertainty. Escalate account-specific issues. Never request passwords.',
    engagementCriteria: 'Engage with help requests, product problems and customer frustration.',
    mainModel: 'deepseek/deepseek-v4.1-flash-1017',
    evaluatorModel: 'deepseek/deepseek-v4.1-flash-1017',
  };
  const mayaBase = {
    role: 'Relationship facilitator',
    personality: mayaPersonality,
    mission:
      "Learn consenting participants' needs and offers, then arrange introductions with double opt-in.",
    instructions:
      'Explain the mutual benefit. Obtain consent from all parties before sharing private information. Never invent contacts.',
    engagementCriteria:
      'Engage where a clear need and a complementary offer suggest a useful connection.',
    mainModel: 'deepseek/deepseek-v4.1-flash-1017',
    evaluatorModel: 'deepseek/deepseek-v4.1-flash-1017',
  };
  return [
    {
      id: DEMO_CONFIGS.johnV1,
      agentId: DEMO_AGENTS.john,
      version: 1,
      config: baseConfig('John', johnBase),
      createdOffsetMs: -14 * 24 * 60 * 60 * 1000,
    },
    {
      id: DEMO_CONFIGS.johnV2,
      agentId: DEMO_AGENTS.john,
      version: 2,
      config: baseConfig('John', {
        ...johnBase,
        instructions: `${johnBase.instructions} Prefer short replies under 120 words.`,
      }),
      createdOffsetMs: -3 * 24 * 60 * 60 * 1000,
    },
    {
      id: DEMO_CONFIGS.sarahV1,
      agentId: DEMO_AGENTS.sarah,
      version: 1,
      config: baseConfig('Sarah', sarahBase),
      createdOffsetMs: -10 * 24 * 60 * 60 * 1000,
    },
    {
      id: DEMO_CONFIGS.sarahV2,
      agentId: DEMO_AGENTS.sarah,
      version: 2,
      config: baseConfig('Sarah', {
        ...sarahBase,
        personality: `${sarahPersonality} Lead with empathy before steps.`,
      }),
      createdOffsetMs: -2 * 24 * 60 * 60 * 1000,
    },
    {
      id: DEMO_CONFIGS.mayaV1,
      agentId: DEMO_AGENTS.maya,
      version: 1,
      config: baseConfig('Maya', mayaBase),
      createdOffsetMs: -7 * 24 * 60 * 60 * 1000,
    },
  ];
}

function succeededResult(overrides?: Partial<SimulationResult>): SimulationResult {
  return {
    steps: [
      {
        stage: 'evaluator',
        model: 'deepseek/deepseek-v4.1-flash-1017',
        inputTokens: 420,
        outputTokens: 96,
        costMicros: 1200,
        decision: {
          relevant: true,
          priority: 0.82,
          reason: 'Clear product interest with a concrete next-step ask.',
          actions: [
            {
              type: 'reply',
              reason: 'Answer the question and offer a short demo.',
              draft: null,
            },
          ],
        },
      },
      {
        stage: 'main',
        model: 'deepseek/deepseek-v4.1-flash-1017',
        inputTokens: 980,
        outputTokens: 210,
        costMicros: 4500,
        decision: {
          relevant: true,
          priority: 0.88,
          reason: 'Prospect asked about scheduling a walkthrough.',
          actions: [
            {
              type: 'reply',
              reason: 'Confirm interest and propose two demo slots.',
              draft:
                'Happy to help. I can set up a 20-minute walkthrough with our team — Tuesday 15:00 UTC or Wednesday 10:00 UTC work on your side?',
            },
          ],
        },
      },
    ],
    actions: [
      {
        type: 'reply',
        reason: 'Confirm interest and propose two demo slots.',
        draft:
          'Happy to help. I can set up a 20-minute walkthrough with our team — Tuesday 15:00 UTC or Wednesday 10:00 UTC work on your side?',
        policy: 'suppressed',
        effect: 'Simulation only. No external action performed.',
      },
    ],
    error: null,
    ...overrides,
  };
}

function failedResult(): SimulationResult {
  return {
    steps: [
      {
        stage: 'evaluator',
        model: 'deepseek/deepseek-v4.1-flash-1017',
        inputTokens: 310,
        outputTokens: 40,
        costMicros: 800,
        decision: {
          relevant: true,
          priority: 0.6,
          reason: 'Support request is in scope.',
          actions: [
            {
              type: 'reply',
              reason: 'Acknowledge and ask for error details.',
              draft: null,
            },
          ],
        },
      },
    ],
    actions: [],
    error:
      'Unable to complete inference. Check the agent credential or OPENROUTER_API_KEY, server encryption key and provider availability, then try again.',
  };
}

function interruptedResult(): SimulationResult {
  return {
    steps: [
      {
        stage: 'evaluator',
        model: 'deepseek/deepseek-v4.1-flash-1017',
        inputTokens: 350,
        outputTokens: 55,
        costMicros: 900,
        decision: {
          relevant: true,
          priority: 0.7,
          reason: 'Buying signal present.',
          actions: [
            {
              type: 'reply',
              reason: 'Continue discovery.',
              draft: null,
            },
          ],
        },
      },
    ],
    actions: [],
    error: null,
    reservedStages: ['evaluator', 'main'],
    dispatchedStages: ['evaluator'],
  };
}

export function demoRuns(): DemoRunSpec[] {
  return [
    {
      id: DEMO_RUNS.johnSucceeded,
      jobId: DEMO_JOBS.johnSucceeded,
      agentId: DEMO_AGENTS.john,
      configurationId: DEMO_CONFIGS.johnV2,
      input:
        'We are evaluating agent control centres for our GTM team. Can Orbit schedule a demo this week?',
      recipients: [],
      status: 'completed',
      result: succeededResult(),
      createdOffsetMs: -36 * 60 * 60 * 1000,
      finishedOffsetMs: -36 * 60 * 60 * 1000 + 12_000,
      expiresOffsetMs: -35 * 60 * 60 * 1000,
      deferReason: null,
    },
    {
      id: DEMO_RUNS.johnFailed,
      jobId: DEMO_JOBS.johnFailed,
      agentId: DEMO_AGENTS.john,
      configurationId: DEMO_CONFIGS.johnV2,
      input: 'What pricing tiers do you offer for five seats?',
      recipients: [],
      status: 'failed',
      result: failedResult(),
      createdOffsetMs: -20 * 60 * 60 * 1000,
      finishedOffsetMs: -20 * 60 * 60 * 1000 + 4_000,
      expiresOffsetMs: -19 * 60 * 60 * 1000,
      deferReason: null,
    },
    {
      id: DEMO_RUNS.johnInterrupted,
      jobId: DEMO_JOBS.johnInterrupted,
      agentId: DEMO_AGENTS.john,
      configurationId: DEMO_CONFIGS.johnV1,
      input: 'Can John follow up with our VP of Sales on LinkedIn?',
      recipients: [],
      status: 'interrupted',
      result: interruptedResult(),
      createdOffsetMs: -6 * 60 * 60 * 1000,
      finishedOffsetMs: null,
      expiresOffsetMs: -5 * 60 * 60 * 1000,
      deferReason: null,
    },
    {
      id: DEMO_RUNS.sarahSucceeded,
      jobId: DEMO_JOBS.sarahSucceeded,
      agentId: DEMO_AGENTS.sarah,
      configurationId: DEMO_CONFIGS.sarahV2,
      input: 'Our simulation stays queued for several minutes. How do we check worker health?',
      recipients: [],
      status: 'completed',
      result: succeededResult({
        actions: [
          {
            type: 'reply',
            reason: 'Walk through worker health checks.',
            draft:
              'Check the worker process is running, then look at the job claim expiry in Activity. If leases are stuck, restart the worker and retry the simulation.',
            policy: 'suppressed',
            effect: 'Simulation only. No external action performed.',
          },
          {
            type: 'escalate',
            reason: 'Account-specific worker logs may need a human.',
            draft: null,
            policy: 'needs-approval',
            effect: 'Held for administrator review.',
          },
        ],
        steps: [
          {
            stage: 'evaluator',
            model: 'deepseek/deepseek-v4.1-flash-1017',
            inputTokens: 400,
            outputTokens: 80,
            costMicros: 1100,
            decision: {
              relevant: true,
              priority: 0.75,
              reason: 'Operational support question.',
              actions: [
                {
                  type: 'reply',
                  reason: 'Provide troubleshooting steps.',
                  draft: null,
                },
              ],
            },
          },
          {
            stage: 'main',
            model: 'deepseek/deepseek-v4.1-flash-1017',
            inputTokens: 900,
            outputTokens: 180,
            costMicros: 3800,
            decision: {
              relevant: true,
              priority: 0.8,
              reason: 'Needs clear steps plus optional escalation.',
              actions: [
                {
                  type: 'reply',
                  reason: 'Walk through worker health checks.',
                  draft:
                    'Check the worker process is running, then look at the job claim expiry in Activity. If leases are stuck, restart the worker and retry the simulation.',
                },
                {
                  type: 'escalate',
                  reason: 'Account-specific worker logs may need a human.',
                  draft: null,
                },
              ],
            },
          },
        ],
      }),
      createdOffsetMs: -28 * 60 * 60 * 1000,
      finishedOffsetMs: -28 * 60 * 60 * 1000 + 9_000,
      expiresOffsetMs: -27 * 60 * 60 * 1000,
      deferReason: null,
    },
    {
      id: DEMO_RUNS.sarahFailed,
      jobId: DEMO_JOBS.sarahFailed,
      agentId: DEMO_AGENTS.sarah,
      configurationId: DEMO_CONFIGS.sarahV1,
      input: 'Please reset my production OpenRouter key immediately.',
      recipients: ['acct-support-42'],
      status: 'failed',
      result: failedResult(),
      createdOffsetMs: -12 * 60 * 60 * 1000,
      finishedOffsetMs: -12 * 60 * 60 * 1000 + 3_000,
      expiresOffsetMs: -11 * 60 * 60 * 1000,
      deferReason: null,
    },
    {
      id: DEMO_RUNS.mayaSucceeded,
      jobId: DEMO_JOBS.mayaSucceeded,
      agentId: DEMO_AGENTS.maya,
      configurationId: DEMO_CONFIGS.mayaV1,
      input:
        'Alex builds evaluation harnesses; Priya needs LLM eval help for her support agent. Worth an intro?',
      recipients: ['alex-evals', 'priya-support'],
      status: 'completed',
      result: succeededResult({
        actions: [
          {
            type: 'introduce',
            reason: 'Complementary skills with mutual benefit.',
            draft:
              'Alex, meet Priya — she is looking for eval patterns for support agents. Priya, Alex has shipped harnesses in this space. Both consented to a short intro.',
            policy: 'needs-approval',
            effect: 'Held for administrator review.',
          },
        ],
        steps: [
          {
            stage: 'evaluator',
            model: 'deepseek/deepseek-v4.1-flash-1017',
            inputTokens: 500,
            outputTokens: 90,
            costMicros: 1300,
            decision: {
              relevant: true,
              priority: 0.9,
              reason: 'Clear complementary needs.',
              actions: [
                {
                  type: 'introduce',
                  reason: 'Mutual benefit is evident.',
                  draft: null,
                },
              ],
            },
          },
          {
            stage: 'main',
            model: 'deepseek/deepseek-v4.1-flash-1017',
            inputTokens: 1100,
            outputTokens: 160,
            costMicros: 4200,
            decision: {
              relevant: true,
              priority: 0.92,
              reason: 'Both parties benefit from a focused introduction.',
              actions: [
                {
                  type: 'introduce',
                  reason: 'Complementary skills with mutual benefit.',
                  draft:
                    'Alex, meet Priya — she is looking for eval patterns for support agents. Priya, Alex has shipped harnesses in this space. Both consented to a short intro.',
                },
              ],
            },
          },
        ],
      }),
      createdOffsetMs: -48 * 60 * 60 * 1000,
      finishedOffsetMs: -48 * 60 * 60 * 1000 + 11_000,
      expiresOffsetMs: -47 * 60 * 60 * 1000,
      deferReason: null,
    },
  ];
}

export interface DemoUsageSpec {
  agentId: string;
  period: 'day' | 'month';
  periodStart: string;
  spendMicros: bigint;
  requests: number;
  outboundActions: number;
}

export function demoUsage(now: Date): DemoUsageSpec[] {
  const day = utcDay(now);
  const month = utcMonthStart(now);
  return [
    {
      agentId: DEMO_AGENTS.john,
      period: 'day',
      periodStart: day,
      spendMicros: BigInt(125_000),
      requests: 14,
      outboundActions: 0,
    },
    {
      agentId: DEMO_AGENTS.john,
      period: 'month',
      periodStart: month,
      spendMicros: BigInt(1_850_000),
      requests: 180,
      outboundActions: 2,
    },
    {
      agentId: DEMO_AGENTS.sarah,
      period: 'day',
      periodStart: day,
      spendMicros: BigInt(48_000),
      requests: 6,
      outboundActions: 0,
    },
    {
      agentId: DEMO_AGENTS.sarah,
      period: 'month',
      periodStart: month,
      spendMicros: BigInt(620_000),
      requests: 70,
      outboundActions: 1,
    },
    {
      agentId: DEMO_AGENTS.maya,
      period: 'month',
      periodStart: month,
      spendMicros: BigInt(210_000),
      requests: 22,
      outboundActions: 0,
    },
  ];
}

export interface DemoConsentSpec {
  agentId: string;
  recipient: string;
  scope: 'introduce' | 'escalate';
  evidence: string;
  granted: boolean;
  updatedOffsetMs: number;
}

export function demoConsents(): DemoConsentSpec[] {
  return [
    {
      agentId: DEMO_AGENTS.maya,
      recipient: 'alex-evals',
      scope: 'introduce',
      evidence: 'Demo seed: Alex opted in via playground scenario on 2026-03-01.',
      granted: true,
      updatedOffsetMs: -40 * 60 * 60 * 1000,
    },
    {
      agentId: DEMO_AGENTS.maya,
      recipient: 'priya-support',
      scope: 'introduce',
      evidence: 'Demo seed: Priya opted in via playground scenario on 2026-03-01.',
      granted: true,
      updatedOffsetMs: -40 * 60 * 60 * 1000,
    },
    {
      agentId: DEMO_AGENTS.sarah,
      recipient: 'acct-support-42',
      scope: 'escalate',
      evidence: 'Demo seed: customer requested human escalation in ticket #42.',
      granted: true,
      updatedOffsetMs: -15 * 60 * 60 * 1000,
    },
    {
      agentId: DEMO_AGENTS.sarah,
      recipient: 'acct-opted-out',
      scope: 'escalate',
      evidence: 'Demo seed: recipient withdrew escalation consent.',
      granted: false,
      updatedOffsetMs: -8 * 60 * 60 * 1000,
    },
  ];
}

/** Fingerprint of the logical demo plan for idempotency tests (no DB). */
export function demoPlanFingerprint(now: Date): string {
  const agents = demoAgents().map((agent) => ({
    id: agent.id,
    name: agent.name,
    lifecycle: agent.lifecycle,
    templateId: agent.templateId,
  }));
  const configs = demoConfigurations().map((row) => ({
    id: row.id,
    agentId: row.agentId,
    version: row.version,
    createdAt: demoTime(now, row.createdOffsetMs).toISOString(),
  }));
  const runs = demoRuns().map((row) => ({
    id: row.id,
    status: row.status,
    agentId: row.agentId,
    createdAt: demoTime(now, row.createdOffsetMs).toISOString(),
  }));
  const usage = demoUsage(now).map((row) => ({
    agentId: row.agentId,
    period: row.period,
    periodStart: row.periodStart,
    spendMicros: row.spendMicros.toString(),
    requests: row.requests,
  }));
  const consents = demoConsents().map((row) => ({
    agentId: row.agentId,
    recipient: row.recipient,
    scope: row.scope,
    granted: row.granted,
  }));
  return JSON.stringify({ agents, configs, runs, usage, consents });
}
