import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { Prisma } from "../generated/prisma/client.js";

import { DEFAULT_DISPLAY_SCALE, DISPLAY_SCALE, displayScaleOf } from "./display-scale.js";
import { LedgerError, LedgerErrorCode } from "./errors.js";
import { ExactDecimal, assertCurrency, sumExact, toExact } from "./money.js";

/** Pure rules, no database: these run everywhere, CI included. */

const rejectsWith = (code: LedgerErrorCode, run: () => unknown): void => {
  expect(run).toThrow(LedgerError);
  try {
    run();
  } catch (error) {
    expect((error as LedgerError).code).toBe(code);
  }
};

/** An amount NUMERIC(38, 18) holds: up to 20 integer digits and 18 fractional ones. */
const representable = fc
  .tuple(
    fc.boolean(),
    fc.bigInt({ min: 0n, max: 10n ** 20n - 1n }),
    fc.bigInt({ min: 0n, max: 10n ** 18n - 1n }),
  )
  .map(
    ([negative, whole, fraction]) =>
      `${negative ? "-" : ""}${whole.toString()}.${fraction.toString().padStart(18, "0")}`,
  );

describe("ExactDecimal (ledger.md section 7: the ledger never rounds)", () => {
  it("stays exact where Prisma.Decimal rounds to 20 significant digits", () => {
    const big = "12345678901234567890.123456789012345678";
    const tiny = "0.000000000000000001";

    // The trap this type exists for: Prisma's Decimal silently drops the last digits.
    expect(new Prisma.Decimal(big).plus(tiny).toFixed()).toBe("12345678901234567890");
    expect(new ExactDecimal(big).plus(tiny).toFixed()).toBe(
      "12345678901234567890.123456789012345679",
    );
  });

  it("would let Prisma.Decimal call an unbalanced transaction balanced, and does not", () => {
    const amounts = ["10000000000000000000", "0.000000000000000001", "-10000000000000000000"];

    const rounded = amounts.reduce((sum, a) => sum.plus(a), new Prisma.Decimal(0));
    expect(rounded.isZero()).toBe(true);

    expect(sumExact(amounts.map((a) => new ExactDecimal(a))).toFixed()).toBe(
      "0.000000000000000001",
    );
  });

  it("sums any representable amounts to the exact total", () => {
    fc.assert(
      fc.property(fc.array(representable, { minLength: 1, maxLength: 20 }), (amounts) => {
        // Integer arithmetic in units of 1e-18 is the independent oracle.
        const units = (a: string): bigint => {
          const negative = a.startsWith("-");
          const [whole = "0", fraction = ""] = a.replace("-", "").split(".");
          const value = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
          return negative ? -value : value;
        };
        const expected = amounts.reduce((sum, a) => sum + units(a), 0n);

        const total = sumExact(amounts.map(toExact));

        expect(units(total.toFixed(18))).toBe(expected);
      }),
    );
  });
});

describe("toExact", () => {
  it("accepts every amount NUMERIC(38, 18) holds, from a string, bigint or Decimal", () => {
    fc.assert(
      fc.property(representable, (amount) => {
        expect(toExact(amount).toFixed(18)).toBe(new ExactDecimal(amount).toFixed(18));
        expect(toExact(new Prisma.Decimal(amount)).toFixed(18)).toBe(
          new ExactDecimal(amount).toFixed(18),
        );
      }),
    );
    expect(toExact(123n).toFixed()).toBe("123");
  });

  it("rejects more than 18 decimal places, which Postgres would round", () => {
    rejectsWith(LedgerErrorCode.AMOUNT_NOT_REPRESENTABLE, () => toExact("0.0000000000000000001"));
  });

  it("rejects 21 integer digits, which NUMERIC(38, 18) cannot hold", () => {
    rejectsWith(LedgerErrorCode.AMOUNT_NOT_REPRESENTABLE, () => toExact("100000000000000000000"));
    expect(toExact("99999999999999999999.999999999999999999").toFixed()).toBe(
      "99999999999999999999.999999999999999999",
    );
  });

  it("rejects what is not a finite decimal", () => {
    for (const bad of ["", "abc", "NaN", "Infinity", "-Infinity", "1,5"]) {
      rejectsWith(LedgerErrorCode.AMOUNT_NOT_REPRESENTABLE, () => toExact(bad));
    }
  });

  it("rejects a JavaScript number that got past the type", () => {
    rejectsWith(LedgerErrorCode.AMOUNT_NOT_REPRESENTABLE, () => toExact(0.1 as unknown as string));
  });
});

describe("assertCurrency (ledger.md section 7)", () => {
  it("accepts three or four uppercase letters", () => {
    for (const code of ["USD", "BTC", "USDT"]) {
      expect(assertCurrency(code)).toBe(code);
    }
  });

  it("rejects anything else", () => {
    for (const code of ["", "US", "usd", "Usd", "DOLLARS", "US1", " USD", "USD\n"]) {
      rejectsWith(LedgerErrorCode.INVALID_CURRENCY, () => assertCurrency(code));
    }
  });
});

describe("display scale (ledger.md section 7)", () => {
  it("shows USD to 2 places and everything else to 8", () => {
    expect(DISPLAY_SCALE.USD).toBe(2);
    expect(displayScaleOf("USD")).toBe(2);
    expect(displayScaleOf("BTC")).toBe(DEFAULT_DISPLAY_SCALE);
    expect(displayScaleOf("ETH")).toBe(8);
    expect(displayScaleOf("toString")).toBe(8);
  });
});
