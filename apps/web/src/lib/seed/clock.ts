/** Timestamps relative to a fixed "now" so screenshots stay stable across reseeds. */
export function demoTime(now: Date, offsetMs: number): Date {
  return new Date(now.getTime() + offsetMs);
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function utcMonthStart(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}
