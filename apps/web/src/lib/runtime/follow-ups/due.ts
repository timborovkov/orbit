/**
 * Convert a browser `datetime-local` value (no timezone) into an offset-bearing
 * ISO-8601 timestamp using the environment's local timezone (the browser on
 * the client). Returns null when the value is not a valid local datetime.
 */
export function localDatetimeToOffsetIso(localValue: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localValue.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] ? Number(match[6]) : 0;
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null;
  }
  return date.toISOString();
}

/** True when the string ends with Z or a numeric UTC offset (±HH:MM / ±HHMM). */
export function hasTimezoneOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
}

/**
 * Parse a due time that must include an explicit timezone offset (Z or ±HH:MM).
 * Rejects bare `datetime-local` strings so the server never silently shifts them.
 */
export function parseOffsetBearingDueAt(raw: string): Date | null {
  const value = raw.trim();
  if (!hasTimezoneOffset(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}
