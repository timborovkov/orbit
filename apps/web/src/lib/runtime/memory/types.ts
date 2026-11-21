import { z } from 'zod';

import { redactString } from '@/lib/observability/redact';
import type { runs } from '@/lib/schema';

export const MEMORY_SEARCH = 'memory.search';
export const MEMORY_CAPTURE = 'memory.capture';
export const MEMORY_EMBED_JOB = 'memory.embed';
export const MEMORY_LIMIT = 4;

export type MemorySubject = 'company' | 'project';
export type MemoryRef = { id: string; revision: string };
export type RecalledMemory = MemoryRef & {
  subjectKind: MemorySubject;
  subject: string;
  topic: string;
  fact: string;
  learnedAt: string;
};

export function memoryCaptureOrigin(origin: typeof runs.$inferSelect.origin | null | undefined) {
  return origin === 'email' || origin === 'discovery';
}

const restrictedMemory =
  /\b(?:consent|opt[ -]?out|passwords?|passphrases?|api[ _-]?keys?|bearer|(?:access|auth|refresh) tokens?|private keys?|credentials?|client secrets?|system prompts?|tool permissions?|approval settings?|blocklists?)\b/i;

function safeMemoryText(value: string) {
  return !restrictedMemory.test(value) && redactString(value) === value;
}

const memoryText = (max: number) =>
  z.string().trim().min(1).max(max).refine(safeMemoryText, 'Use company or project information.');
export const memoryFact = memoryText(500);
export const memoryDate = z.iso.date();

export const memoryCandidate = z.object({
  subjectKind: z.enum(['company', 'project']),
  subject: memoryText(120),
  topic: memoryText(80),
  fact: memoryFact,
  quote: memoryText(400),
  expiresOn: memoryDate.nullish(),
  reviewOn: memoryDate.nullish(),
});
export type MemoryCandidate = z.infer<typeof memoryCandidate>;

export function memoryEvidenceHref(agentId: string, entry: MemoryRef) {
  return `/agents/${agentId}/memory/${entry.id}/evidence?revision=${entry.revision}`;
}
