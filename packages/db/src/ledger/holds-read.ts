import { HoldState } from "../generated/prisma/enums.js";

import { accountTypeOf } from "./balances.js";
import { assertCurrency, fromPrisma, type ExactDecimal } from "./money.js";
import type { LedgerDb } from "./transaction.js";

/**
 * The sum of an account's ACTIVE holds in a currency, computed now by Postgres, which sums NUMERIC
 * exactly (accounts.md section 4). Zero when there are none, including for the treasury, which
 * places no orders.
 *
 * Read outside a writer's lock, the figure is a snapshot: a concurrent hold may change it a moment
 * later.
 */
export const heldOf = async (
  db: LedgerDb,
  accountId: string,
  currency: string,
): Promise<ExactDecimal> => {
  assertCurrency(currency);
  await accountTypeOf(db, accountId);
  const { _sum } = await db.hold.aggregate({
    where: { accountId, currency, state: HoldState.ACTIVE },
    _sum: { amount: true },
  });
  return fromPrisma(_sum.amount);
};
