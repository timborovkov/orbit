const relevanceLimit = 140;

export function personInitials(name: string): string {
  const words = name
    .replace(/^@/, '')
    .split('@')[0]
    .split(/[\s._-]+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  const letters = words
    .slice(0, 2)
    .map((word) => Array.from(word.replace(/^[^\p{L}\p{N}]+/u, ''))[0]);
  return letters.join('').toUpperCase() || '?';
}

export function relevanceSnippet(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const characters = Array.from(text);
  return characters.length > relevanceLimit
    ? `${characters
        .slice(0, relevanceLimit - 1)
        .join('')
        .trimEnd()}…`
    : text;
}
