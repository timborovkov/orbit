/** Decode common HTML entities without pulling in a dependency. */
const namedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const UNICODE_MAX_CODE_POINT = 0x10ffff;

/** Convert a numeric entity only when the code point is in the Unicode range. */
function codePointFromNumericEntity(code: number, match: string): string {
  if (!Number.isFinite(code) || code < 0 || code > UNICODE_MAX_CODE_POINT) {
    return match;
  }
  return String.fromCodePoint(code);
}

export function decodeHtmlEntities(value: string): string {
  let current = value;
  // Repeat so nested encodings like `&amp;nbsp;` fully resolve.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith('#x')) {
        const code = Number.parseInt(lower.slice(2), 16);
        return codePointFromNumericEntity(code, match);
      }
      if (lower.startsWith('#')) {
        const code = Number.parseInt(lower.slice(1), 10);
        return codePointFromNumericEntity(code, match);
      }
      return namedEntities[lower] ?? match;
    });
    if (next === current) break;
    current = next;
  }
  return current.replace(/\u00a0/g, ' ');
}

/** Strip tags after decoding entities; collapse whitespace for list snippets. */
export function plainTextSnippet(value: string | null | undefined, maxLength = 120): string {
  if (!value) return '';
  const decoded = decodeHtmlEntities(value);
  const withoutTags = decoded
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutTags) return '';
  const characters = Array.from(withoutTags);
  if (characters.length <= maxLength) return withoutTags;
  return `${characters
    .slice(0, maxLength - 1)
    .join('')
    .trimEnd()}…`;
}
