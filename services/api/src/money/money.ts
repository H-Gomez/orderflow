import { Prisma } from "@orderflow/db";
import { z } from "zod";

/** A `NUMERIC(38, 18)` as text: up to 20 integer digits and 18 decimal places, never an exponent. */
export const MONEY_PATTERN = "^-?\\d{1,20}(\\.\\d{1,18})?$";

/** How money crosses this API's boundary. OpenAPI publishes it as the `Money` component. */
export const moneySchema = z.string().regex(new RegExp(MONEY_PATTERN, "u"));

/**
 * Copies a response with every Decimal turned into its exact string. `toFixed()` with no argument
 * neither rounds nor uses an exponent, where `toString()` and so `JSON.stringify` give `"1e-8"` for
 * 0.00000001. `isDecimal` and not `instanceof`, because `ExactDecimal` is a decimal.js clone. This
 * is formatting only: no arithmetic, and `DISPLAY_SCALE` is for displays, not for this API.
 *
 * An object with its own `toJSON`, such as a `Date`, already decides how it serializes.
 */
export const serializeMoney = (value: unknown): unknown => {
  if (Prisma.Decimal.isDecimal(value)) {
    return value.toFixed();
  }
  if (Array.isArray(value)) {
    return value.map(serializeMoney);
  }
  if (typeof value === "object" && value !== null && !("toJSON" in value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serializeMoney(entry)]),
    );
  }
  return value;
};
