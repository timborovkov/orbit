/** Derive a lowercase slug from a human title. */
export function slugifyTitle(title: string, max = 80): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return slug || 'skill';
}
