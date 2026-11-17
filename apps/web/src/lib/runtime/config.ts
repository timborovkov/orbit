import { z } from 'zod';

const prose = z.string().trim().max(12000);
const model = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[\w./:@+-]+$/);
export const configSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: prose,
  personality: prose,
  mission: z.string().trim().max(2000),
  instructions: prose,
  engagementCriteria: prose,
  mainModel: model,
  evaluatorModel: model,
});
export type AgentConfig = z.infer<typeof configSchema>;
export const configFields = [
  ['name', 'Name'],
  ['role', 'Role'],
  ['personality', 'Personality'],
  ['mission', 'Mission'],
  ['instructions', 'Operating instructions'],
  ['engagementCriteria', 'Engagement criteria'],
  ['mainModel', 'Main model'],
  ['evaluatorModel', 'Evaluator model'],
] as const;
