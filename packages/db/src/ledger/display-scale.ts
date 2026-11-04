/**
 * How many decimal places to show a currency with (ledger.md section 7). Display only: rounding
 * is permitted at display and nowhere else, so nothing that writes, compares or sums money
 * imports this file. Anything finer than USD 2 and everything else 8 is ledger.md question 5.
 */
export const DISPLAY_SCALE = { USD: 2 } as const;

/** Every currency not named in {@link DISPLAY_SCALE}: crypto shows 8 places. */
export const DEFAULT_DISPLAY_SCALE = 8;

/** The display scale of a currency. */
export const displayScaleOf = (currency: string): number =>
  Object.hasOwn(DISPLAY_SCALE, currency)
    ? DISPLAY_SCALE[currency as keyof typeof DISPLAY_SCALE]
    : DEFAULT_DISPLAY_SCALE;
