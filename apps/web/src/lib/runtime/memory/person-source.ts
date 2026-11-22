import type { PersonMemoryField } from '@/lib/runtime/memory/types';

const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });
const selfStatements = [
  /^I (?:currently )?work (?:at|for) (?<company>.+?)(?: as (?:an? |the )?(?<job_title>.+))?$/di,
  /^I(?: am |['’]m )(?:currently )?(?:an? |the )(?<job_title>.+?) (?:at|for|with) (?<company>.+)$/di,
  /^I (?:currently )?(?:work|serve) as (?:an? |the )?(?<job_title>.+?)(?: at (?<company>.+))?$/di,
  /^My (?:current )?employer is (?<company>.+)$/di,
  /^My (?:current )?(?:job )?title is (?<job_title>.+)$/di,
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
      for (const form of selfStatements) {
        const match = statement.match(form);
        const span = match?.indices?.groups?.[field];
        if (
          match?.groups?.[field] === value &&
          span &&
          quote.includes(statement.slice(0, span[1]))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}
