/** Pure UI/edge conversions between USD dollars and stored cents. Storage stays in cents; usage in micros. */

export const spendFormFields = {
  dailySpendCents: { dollars: 'dailySpendDollars', unlimited: 'dailySpendUnlimited' },
  monthlySpendCents: { dollars: 'monthlySpendDollars', unlimited: 'monthlySpendUnlimited' },
} as const;

export type SpendCapKey = keyof typeof spendFormFields;

const MICROS_PER_CENT = BigInt(10_000);

/** Stored cents → value for a dollar input ("5.00"). Null (no cap) and invalid values give "". */
export function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isSafeInteger(cents) || cents < 0) return '';
  const whole = Math.floor(cents / 100);
  return `${whole}.${String(cents % 100).padStart(2, '0')}`;
}

/** Stored cents → display string ("$5.00"); null means no cap. */
export function formatCapDollars(cents: number | null): string {
  return cents === null ? 'No cap' : `$${centsToDollarsInput(cents)}`;
}

/**
 * Dollar input → whole cents, rounding half up at the third decimal using decimal-string math
 * (no float error: "1.005" → 101). Accepts an optional "$" and thousands commas.
 * Blank, negative, non-numeric and unsafe values return undefined.
 */
export function dollarsInputToCents(input: string | null | undefined): number | undefined {
  if (typeof input !== 'string') return undefined;
  const match = /^\$?(\d+|\d{1,3}(?:,\d{3})+)?(?:\.(\d*))?$/.exec(input.trim());
  if (!match) return undefined;
  const wholeText = (match[1] ?? '').replaceAll(',', '');
  const fraction = match[2] ?? '';
  if (wholeText === '' && fraction === '') return undefined;
  const digits = fraction.padEnd(3, '0');
  const cents =
    Number(wholeText === '' ? '0' : wholeText) * 100 +
    Number(digits.slice(0, 2)) +
    (Number(digits[2]) >= 5 ? 1 : 0);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

/**
 * Form values for one spend cap → value for `budgetsSchema`: null when the no-cap flag is on,
 * cents when the dollar field parses, undefined (fails validation) otherwise.
 */
export function spendCapCentsFromForm(
  dollars: FormDataEntryValue | null,
  unlimited: FormDataEntryValue | null,
): number | null | undefined {
  if (unlimited === 'on') return null;
  return typeof dollars === 'string' ? dollarsInputToCents(dollars) : undefined;
}

/**
 * Usage micros (1/1,000,000 USD) → "$0.05". Shows cents precision, extending to four decimals
 * only when sub-cent spend exists, and "<$0.0001" for non-zero amounts below that.
 */
export function formatSpendDollars(micros: bigint): string {
  if (micros <= BigInt(0)) return '$0.00';
  if (micros % MICROS_PER_CENT === BigInt(0)) {
    const cents = Number(micros / MICROS_PER_CENT);
    return `$${centsToDollarsInput(cents)}`;
  }
  const tenThousandths = (micros + BigInt(50)) / BigInt(100);
  if (tenThousandths === BigInt(0)) return '<$0.0001';
  const whole = tenThousandths / BigInt(10_000);
  const fraction = String(tenThousandths % BigInt(10_000)).padStart(4, '0');
  const decimals = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `$${whole}.${decimals}`;
}
