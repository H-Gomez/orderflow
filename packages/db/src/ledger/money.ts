import { Prisma } from "../generated/prisma/client.js";

import { LedgerError, LedgerErrorCode } from "./errors.js";

/**
 * Exact decimal arithmetic for money (ledger.md section 7: the ledger never rounds).
 *
 * `Prisma.Decimal` is decimal.js at its default precision of 20 significant digits, so its
 * arithmetic rounds: `12345678901234567890.123456789012345678` plus `0.000000000000000001` comes
 * back as `12345678901234567890`. A NUMERIC(38, 18) amount has up to 38 significant digits, and
 * a sum of them more, so every addition, subtraction or comparison of money in this package goes
 * through this clone instead. 100 digits is far beyond any sum of NUMERIC(38, 18) amounts, so
 * nothing it computes is ever rounded; half-even is set only because ledger.md names it.
 */
export const ExactDecimal = Prisma.Decimal.clone({
  precision: 100,
  rounding: Prisma.Decimal.ROUND_HALF_EVEN,
});
export type ExactDecimal = Prisma.Decimal;

/**
 * An amount as a caller may pass it. There is deliberately no `number`: a JavaScript number is
 * binary floating point and has already lost the exact value before it arrives (ledger.md
 * section 7).
 */
export type AmountInput = Prisma.Decimal | string | bigint;

/** NUMERIC(38, 18): 18 fractional digits and 20 integer digits. */
const MAX_SCALE = 18;
const LIMIT = new ExactDecimal("1e20");

const CURRENCY = /^[A-Z]{3,4}$/u;

/** Parses an amount exactly, or rejects it as something the ledger cannot hold. */
export const toExact = (input: AmountInput): ExactDecimal => {
  let parsed: ExactDecimal;
  try {
    if (typeof input === "string") {
      parsed = new ExactDecimal(input);
    } else if (typeof input === "bigint") {
      parsed = new ExactDecimal(input.toString());
    } else if (Prisma.Decimal.isDecimal(input)) {
      parsed = new ExactDecimal(input.toFixed());
    } else {
      throw new TypeError("not an amount");
    }
  } catch {
    throw new LedgerError(
      LedgerErrorCode.AMOUNT_NOT_REPRESENTABLE,
      "an amount is a decimal string, a bigint or a Decimal, never a JavaScript number (ledger.md section 7)",
    );
  }
  return assertRepresentable(parsed);
};

/**
 * Rejects an amount NUMERIC(38, 18) would round or refuse. Postgres rounds a value with more
 * than 18 fractional digits without a word, which would break "the ledger never rounds".
 */
export const assertRepresentable = (amount: ExactDecimal): ExactDecimal => {
  if (!amount.isFinite() || amount.decimalPlaces() > MAX_SCALE || amount.abs().gte(LIMIT)) {
    throw new LedgerError(
      LedgerErrorCode.AMOUNT_NOT_REPRESENTABLE,
      `${amount.toFixed()} does not fit NUMERIC(38, 18) exactly: at most 18 decimal places and 20 integer digits (ledger.md section 7)`,
    );
  }
  return amount;
};

/** A currency is its uppercase ticker of three or four letters (ledger.md section 7). */
export const assertCurrency = (currency: string): string => {
  if (!CURRENCY.test(currency)) {
    throw new LedgerError(
      LedgerErrorCode.INVALID_CURRENCY,
      `${JSON.stringify(currency)} is not a three or four letter uppercase currency code (ledger.md section 7)`,
    );
  }
  return currency;
};

/** Sums amounts exactly. */
export const sumExact = (amounts: Iterable<ExactDecimal>): ExactDecimal => {
  let total = new ExactDecimal(0);
  for (const amount of amounts) {
    total = total.plus(amount);
  }
  return total;
};

/** Re-reads a value from Prisma, which arrives at precision 20, into the exact type. */
export const fromPrisma = (value: Prisma.Decimal | null): ExactDecimal =>
  new ExactDecimal(value === null ? "0" : value.toFixed());
