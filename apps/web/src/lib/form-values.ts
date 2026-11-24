/** Parse list fields from a form (one entry per repeated name, or newline-delimited). */
export function listValuesFromForm(form: FormData, name: string, max = 20): string[] {
  const values = form
    .getAll(name)
    .flatMap((value) => (typeof value === 'string' ? value.split('\n') : []))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)].slice(0, max);
}
