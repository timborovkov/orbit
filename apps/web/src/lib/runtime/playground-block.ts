/** Detect Playground admission blocks that should restore the user's draft. */

export function isPlaygroundAdmissionBlock(message: string | null | undefined): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    text.includes('could not start') ||
    text.includes('already busy') ||
    text.includes('concurrency limit') ||
    text.includes('work was deferred') ||
    text.includes('daily request quota') ||
    text.includes('spend cap') ||
    text.includes('spend reservation')
  );
}

export function playgroundBlockRetryLabel(message: string | null | undefined): string {
  if (!message) return 'Retry';
  if (/busy|could not start|concurrency/i.test(message)) return 'Retry when free';
  return 'Retry';
}
