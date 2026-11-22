import type { PersonMemoryField } from '@/lib/runtime/memory/types';

const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });
// Capture every part of each form so the evidence can include the exact prefix
// through the matching value, including when a later clause names another field.
const selfStatements: { pattern: RegExp; company?: number; job_title?: number }[] = [
  {
    pattern: /^(I (?:currently )?work (?:at|for) )(.+?)(?:( as (?:an? |the )?)(.+))?$/i,
    company: 2,
    job_title: 4,
  },
  {
    pattern: /^(I(?: am |['’]m )(?:currently )?(?:an? |the ))(.+?)( (?:at|for|with) )(.+)$/i,
    job_title: 2,
    company: 4,
  },
  {
    pattern: /^(I (?:currently )?(?:work|serve) as (?:an? |the )?)(.+?)(?:( at )(.+))?$/i,
    job_title: 2,
    company: 4,
  },
  { pattern: /^(My (?:current )?employer is )(.+)$/i, company: 2 },
  { pattern: /^(My (?:current )?(?:job )?title is )(.+)$/i, job_title: 2 },
];

export function supportsPersonFact(
  body: string,
  quote: string,
  field: PersonMemoryField,
  value: string,
) {
  if (!body.includes(quote) || !quote.includes(value)) return false;

  // Only explicit self-attribution counts. Check the original sentence, since the
  // model can otherwise crop the attribution out of quoted or reported speech.
  let inCode = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^(?:-{2,}\s*(?:forwarded|original) message\b.*|On .+ wrote:)$/i.test(line)) break;
    if (/^(?:```|~~~)/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode || line.startsWith('>')) continue;
    for (const { segment } of sentences.segment(line)) {
      if (segment.trimEnd().endsWith('?')) continue;
      const statement = segment
        .trim()
        .split(/[,;]/, 1)[0]
        .replace(/[.!]+$/, '');
      for (const { pattern, [field]: group } of selfStatements) {
        if (!group) continue;
        const match = statement.match(pattern);
        if (match?.[group] === value && quote.includes(match.slice(1, group + 1).join(''))) {
          return true;
        }
      }
    }
  }
  return false;
}
