import { z } from 'zod';

import { redactString } from '@/lib/observability/redact';
import type { runs } from '@/lib/schema';

export const MEMORY_SEARCH = 'memory.search';
export const MEMORY_CAPTURE = 'memory.capture';
export const MEMORY_EMBED_JOB = 'memory.embed';
export const MEMORY_LIMIT = 4;

export type MemorySubject = 'company' | 'project' | 'person';
export const personMemoryFields = ['company', 'job_title'] as const;
export type PersonMemoryField = (typeof personMemoryFields)[number];
export const personMemoryLabels = { company: 'Company', job_title: 'Job title' } satisfies Record<
  PersonMemoryField,
  string
>;
export type MemoryRef = { id: string; revision: string };
export type RecalledMemory = MemoryRef & {
  subjectKind: MemorySubject;
  subject: string;
  topic: string;
  fact: string;
  personFact?: { field: PersonMemoryField; value: string };
  learnedAt: string;
};

export function memoryCaptureOrigin(origin: typeof runs.$inferSelect.origin | null | undefined) {
  return Boolean(origin && origin !== 'playground' && origin !== 'replay');
}

const restrictedMemory =
  /\b(?:consent|opt[ -]?out|passwords?|passphrases?|api[ _-]?keys?|bearer|(?:access|auth|refresh) tokens?|private keys?|credentials?|client secrets?|system prompts?|tool permissions?|approval settings?|blocklists?)\b/i;

function safeMemoryText(value: string) {
  return !restrictedMemory.test(value) && redactString(value) === value;
}

const memoryText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(safeMemoryText, 'Use factual information without sensitive settings.');
export const memoryFact = memoryText(500);
export const memoryDate = z.iso.date();
export const personMemoryValue = memoryText(120).refine((value) => !/[\r\n]/.test(value));

const evidenceFields = {
  quote: memoryText(400),
  expiresOn: memoryDate.nullish(),
  reviewOn: memoryDate.nullish(),
};
export const memoryCandidate = z.discriminatedUnion('subjectKind', [
  z.object({
    subjectKind: z.enum(['company', 'project']),
    subject: memoryText(120),
    topic: memoryText(80),
    fact: memoryFact,
    ...evidenceFields,
  }),
  z.object({
    subjectKind: z.literal('person'),
    personFact: z.object({ field: z.enum(personMemoryFields), value: personMemoryValue }),
    ...evidenceFields,
  }),
]);
export type MemoryCandidate = z.infer<typeof memoryCandidate>;

export function personMemoryStatement(subject: string, field: PersonMemoryField, value: string) {
  const statement =
    field === 'company' ? `${subject} works at ${value}` : `${subject}’s job title is ${value}`;
  return statement.endsWith('.') ? statement : `${statement}.`;
}

export function personMemorySubject(author: string | null) {
  const label = author
    ?.replace(/\s*<[^<>]*>\s*$/, '')
    .trim()
    .replace(/^"|"$/g, '')
    .trim();
  const result = personMemoryValue.safeParse(label);
  if (!result.success || /^[^\s@]+@[^\s@]+$/.test(result.data)) return 'This person';
  return result.data;
}

export function memoryEvidenceHref(agentId: string, entry: MemoryRef) {
  return `/agents/${agentId}/memory/${entry.id}/evidence?revision=${entry.revision}`;
}
