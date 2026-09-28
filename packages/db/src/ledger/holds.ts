import type { Hold } from "../generated/prisma/client.js";
import { AccountType, HoldState } from "../generated/prisma/enums.js";

import { accountTypeOf, buyingPowerIn } from "./balances.js";
import { LedgerError, LedgerErrorCode } from "./errors.js";
import { lockBuyingPower } from "./locks.js";
import { assertCurrency, toExact, type AmountInput } from "./money.js";
import { inTransaction, type LedgerDb } from "./transaction.js";

export interface PlaceHoldInput {
  readonly accountId: string;
  /** The order the hold is for. `Hold.orderId` is a required unique key, so it exists already. */
  readonly orderId: string;
  readonly currency: string;
  /** The amount to hold: positive, and never rounded (accounts.md section 4.1). */
  readonly amount: AmountInput;
}

/**
 * Checks buying power and creates an ACTIVE hold in one database transaction (accounts.md
 * section 4.3), so the sum of an account's active holds in a currency never exceeds its
 * balance (section 4.4).
 *
 * The check and the insert are serialised per account and currency by the same advisory lock
 * `postTransaction` takes on a debit, so neither two holds nor a hold and a debit can both
 * spend the same money. Rejects a hold over buying power, a hold of zero or less, and the
 * treasury, which has no buying power (section 5).
 *
 * Given a client it runs in its own transaction, and a rejection leaves the caller's order row
 * alone. Given a transaction client it runs inside the caller's, so an order and its hold
 * commit together or not at all (see {@link LedgerDb}).
 */
export const placeHold = async (db: LedgerDb, input: PlaceHoldInput): Promise<Hold> => {
  const currency = assertCurrency(input.currency);
  const amount = toExact(input.amount);
  if (!amount.isPositive() || amount.isZero()) {
    throw new LedgerError(
      LedgerErrorCode.NON_POSITIVE_HOLD,
      `a hold holds a positive amount, got ${amount.toFixed()} (accounts.md section 4.1)`,
    );
  }

  return inTransaction(db, async (tx) => {
    if ((await accountTypeOf(tx, input.accountId)) === AccountType.TREASURY) {
      throw new LedgerError(
        LedgerErrorCode.TREASURY_HAS_NO_BUYING_POWER,
        "the treasury places no orders and has no buying power (accounts.md section 5)",
      );
    }

    await lockBuyingPower(tx, [{ accountId: input.accountId, currency }]);

    const available = await buyingPowerIn(tx, input.accountId, currency);
    if (amount.gt(available)) {
      throw new LedgerError(
        LedgerErrorCode.INSUFFICIENT_BUYING_POWER,
        `account ${input.accountId} has ${available.toFixed()} ${currency} of buying power and the hold is ${amount.toFixed()} (accounts.md section 4.3)`,
      );
    }

    return tx.hold.create({
      data: {
        accountId: input.accountId,
        orderId: input.orderId,
        currency,
        amount: amount.toFixed(),
        state: HoldState.ACTIVE,
      },
    });
  });
};
